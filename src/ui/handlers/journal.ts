import { renderLayout, type SearchBox } from '../pages/layout.js'
import type { Html } from '../html.js'
import {
  renderCrossSessionSearch,
  renderInvalidSession,
  renderSessionList,
  renderSessionView,
  type JournalViewState,
} from '../pages/journal.js'
import type { UiHandler, UiRequestContext, UiResult } from '../routes.js'
import type { UiSession } from '../auth.js'
import { CONTENT_TYPE_HTML, HTTP_STATUS_BAD_REQUEST, HTTP_STATUS_OK } from '../constants.js'
import type { SessionSummaryEntry } from '../../journal/index-cache.js'
import type {
  CrossSessionSearchOptions,
  CrossSessionSearchResult,
  JournalFilters,
  SessionPage,
  SessionPageOptions,
} from '../../journal/search.js'
import type { JournalDirection } from '../../journal/record.js'
import { isValidSessionId } from '../../journal/session-id.js'

/**
 * `GET /journal` — the journal browser (M4 Task 15). Three views selected by
 * query: the session list (index-cache), one session's records with filters
 * (single-session search), and a cross-session text search with an honest
 * truncation mark. Authorization (viewer+) is done by `server.ts` before this
 * runs; this handler only reads and renders.
 *
 * Fail-closed on the session id: it is NEVER turned into a path here. The
 * handler screens it with the journal layer's own validator and, on rejection,
 * answers a clean 400 without ever calling the read layer — so a traversal
 * attempt is a friendly error, not a 500 and not a disk touch.
 */

/** Sessions listed per page in the session list. */
export const JOURNAL_SESSIONS_PER_PAGE = 50

/** Records read/shown per page in a single-session view. */
export const JOURNAL_RECORDS_PER_PAGE = 100

/**
 * The read seam. Mirrors `search.ts` / `index-cache.ts` so production wiring is
 * a thin pass-through and tests inject a fake without touching disk.
 */
export interface JournalReadPort {
  listSessions(dir?: string): Promise<readonly SessionSummaryEntry[]>
  searchSession(sessionId: string, options?: SessionPageOptions): Promise<SessionPage>
  searchAllSessions(options?: CrossSessionSearchOptions): Promise<CrossSessionSearchResult>
}

export interface JournalHandlerDeps {
  readonly read: JournalReadPort
  /** Journal directory passed through to the read layer (defaults to the layer's own). */
  readonly dir?: string
}

/** Builds the injectable `journalPage` handler bound to a read port. */
export function createJournalHandler(deps: JournalHandlerDeps): UiHandler {
  return async function journalPage(ctx: UiRequestContext): Promise<UiResult> {
    const sessionId = firstNonEmpty(ctx.query.get('session'))
    const text = firstNonEmpty(ctx.query.get('q'))
    const filters = buildFilters(ctx.query, text)
    const page = parsePage(ctx.query.get('page'))

    if (sessionId !== undefined) {
      return renderSingleSession(deps, ctx, sessionId, filters, page)
    }
    if (text !== undefined) {
      return renderSearch(deps, ctx, filters, page)
    }
    return renderList(deps, ctx, page)
  }
}

async function renderList(
  deps: JournalHandlerDeps,
  ctx: UiRequestContext,
  page: number,
): Promise<UiResult> {
  const sessions = await deps.read.listSessions(deps.dir)
  const pageCount = Math.max(1, Math.ceil(sessions.length / JOURNAL_SESSIONS_PER_PAGE))
  const start = (page - 1) * JOURNAL_SESSIONS_PER_PAGE
  const slice = sessions.slice(start, start + JOURNAL_SESSIONS_PER_PAGE)
  const content = renderSessionList(slice, page, pageCount, sessions.length)
  return ok(ctx, content, { search: searchBox(undefined), navMeta: `${sessions.length} sessions` })
}

async function renderSingleSession(
  deps: JournalHandlerDeps,
  ctx: UiRequestContext,
  sessionId: string,
  filters: JournalFilters,
  page: number,
): Promise<UiResult> {
  // The session id is attacker-influenced and would become a file name in the
  // read layer. Screen it with the journal's own validator and refuse cleanly
  // BEFORE any read — never build a path here.
  if (!isValidSessionId(sessionId)) {
    return htmlResponse(ctx, HTTP_STATUS_BAD_REQUEST, renderInvalidSession(), {
      search: searchBox(undefined),
    })
  }
  const options: SessionPageOptions = {
    ...filters,
    ...(deps.dir !== undefined ? { dir: deps.dir } : {}),
    limit: JOURNAL_RECORDS_PER_PAGE,
    offset: (page - 1) * JOURNAL_RECORDS_PER_PAGE,
  }
  const pageData = await deps.read.searchSession(sessionId, options)
  const state: JournalViewState = { sessionId, filters, page }
  return ok(ctx, renderSessionView(sessionId, pageData, state), {
    search: searchBox(filters.text),
    navMeta: `page ${page}`,
  })
}

async function renderSearch(
  deps: JournalHandlerDeps,
  ctx: UiRequestContext,
  filters: JournalFilters,
  page: number,
): Promise<UiResult> {
  const options: CrossSessionSearchOptions = {
    ...filters,
    ...(deps.dir !== undefined ? { dir: deps.dir } : {}),
  }
  const result = await deps.read.searchAllSessions(options)
  const state: JournalViewState = { filters, page }
  const hits = result.hits.length
  return ok(ctx, renderCrossSessionSearch(result, state), {
    search: searchBox(filters.text),
    navMeta: `${hits} ${hits === 1 ? 'hit' : 'hits'}`,
  })
}

/** Reads the recognised filter fields from the query into a `JournalFilters`. */
function buildFilters(query: URLSearchParams, text: string | undefined): JournalFilters {
  const direction = firstNonEmpty(query.get('direction'))
  return {
    ...maybe('kind', firstNonEmpty(query.get('kind'))),
    ...(direction !== undefined ? { direction: direction as JournalDirection } : {}),
    ...maybe('method', firstNonEmpty(query.get('method'))),
    ...maybe('toolName', firstNonEmpty(query.get('tool'))),
    ...maybe('outcome', firstNonEmpty(query.get('outcome'))),
    ...(text !== undefined ? { text } : {}),
  }
}

function maybe(key: string, value: string | undefined): Record<string, string> {
  return value !== undefined ? { [key]: value } : {}
}

/** Parses a 1-based page number, clamping anything invalid up to 1. */
function parsePage(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1
}

/** Trims a query value and drops it to `undefined` when empty. */
function firstNonEmpty(value: string | null): string | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Shell extras per view: the top-bar search box and the tab-bar meta text. */
interface ShellOptions {
  readonly search: SearchBox
  readonly navMeta?: string
}

/**
 * The top-bar search box IS the journal's text search: a real GET form to
 * `/journal` carrying only `q` (so it starts a fresh cross-session search and
 * drops any other filter — refinement is the in-panel filter form's job).
 */
function searchBox(text: string | undefined): SearchBox {
  return {
    action: '/journal',
    name: 'q',
    placeholder: 'search journal — server, tool, status',
    ...(text !== undefined ? { value: text } : {}),
  }
}

function ok(ctx: UiRequestContext, content: Html, shell: ShellOptions): UiResult {
  return htmlResponse(ctx, HTTP_STATUS_OK, content, shell)
}

function htmlResponse(
  ctx: UiRequestContext,
  status: number,
  content: Html,
  shell: ShellOptions,
): UiResult {
  const session = ctx.session
  const admin = currentAdmin(session)
  const body = renderLayout({
    title: 'Journal',
    // `content` is pre-escaped `Html` built by a page renderer through the
    // sanctioned `html` template; the layout inserts it verbatim.
    content,
    csrfToken: session?.csrfToken ?? '',
    ...(admin !== undefined ? { currentAdmin: admin } : {}),
    activeNav: 'journal',
    search: shell.search,
    ...(shell.navMeta !== undefined ? { navMeta: shell.navMeta } : {}),
  })
  return {
    kind: 'response',
    status,
    headers: { 'content-type': CONTENT_TYPE_HTML },
    body,
  }
}

function currentAdmin(session: UiSession | undefined): { name: string; role: string } | undefined {
  return session === undefined ? undefined : { name: session.adminName, role: session.role }
}
