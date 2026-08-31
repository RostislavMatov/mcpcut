import { renderLayout, type SearchBox } from '../pages/layout.js'
import type { Html } from '../html.js'
import {
  renderAllRecords,
  renderCrossSessionSearch,
  renderInvalidSession,
  renderSessionList,
  renderSessionView,
  type JournalViewState,
} from '../pages/journal.js'
import { parseRequest, sessionMatches, type JournalRequest } from './journal-query.js'
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
import { isValidSessionId } from '../../journal/session-id.js'

/**
 * `GET /journal` — the journal browser (M4 Task 15; redrawn from Claude Design
 * `Journal.dc.html` 2026-08-27). Four views selected by query:
 *
 * - the session list (index-cache), narrowed by id/text and by period;
 * - `view=records`, the cross-session record stream behind the `Records` tab;
 * - `session=<id>`, one session's records with filters;
 * - `q=<text>` from the top bar, the cross-session text search with an honest
 *   truncation mark.
 *
 * The period control is server-side state: its day/preset/month cells are
 * submit buttons of the filter form (`pick`, `period`, `pmnav`, `close`), and
 * this handler folds them into the `from`/`to` filters. That keeps the whole
 * bar working with JavaScript off, and makes every view a shareable URL.
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
  /**
   * Names offered by the agent dropdown. Read from the agent registry, not
   * from the records: an agent that has not acted yet must still be
   * selectable, and deriving the list from a page would change it per page.
   * Absent (or failing) leaves the dropdown with just `agent · any`.
   */
  readonly listAgentNames?: () => Promise<readonly string[]>
  /** Clock for the period presets; injected so tests pin "today". */
  readonly now?: () => Date
}

/** Builds the injectable `journalPage` handler bound to a read port. */
export function createJournalHandler(deps: JournalHandlerDeps): UiHandler {
  return async function journalPage(ctx: UiRequestContext): Promise<UiResult> {
    const request = parseRequest(ctx.query, deps.now?.() ?? new Date())

    if (request.sessionId !== undefined) {
      return renderSingleSession(deps, ctx, request.sessionId, request)
    }
    if (request.allSessions) {
      return renderRecordsTab(deps, ctx, request)
    }
    // A bare `q` is the top bar's cross-session search. The same `q` submitted
    // by the session list's own bar carries `view=sessions` and narrows the
    // list instead — the top bar starts a search, the panel bar refines a view.
    if (request.filters.text !== undefined && request.view !== 'sessions') {
      return renderSearch(deps, ctx, request)
    }
    return renderList(deps, ctx, request)
  }
}

// --- Views ----------------------------------------------------------------

async function renderList(
  deps: JournalHandlerDeps,
  ctx: UiRequestContext,
  request: JournalRequest,
): Promise<UiResult> {
  const all = await deps.read.listSessions(deps.dir)
  const sessions = all.filter((entry) => sessionMatches(entry, request.filters))
  const pageCount = Math.max(1, Math.ceil(sessions.length / JOURNAL_SESSIONS_PER_PAGE))
  const start = (request.page - 1) * JOURNAL_SESSIONS_PER_PAGE
  const slice = sessions.slice(start, start + JOURNAL_SESSIONS_PER_PAGE)
  // The session list's own bar has no agent field, so the dropdown's options
  // are not read here — one fewer store touch on the most-visited view.
  const state = viewState(request, [])
  const content = renderSessionList(slice, state, pageCount, sessions.length)
  return ok(ctx, content, { search: searchBox(undefined), navMeta: `${sessions.length} sessions` })
}

async function renderSingleSession(
  deps: JournalHandlerDeps,
  ctx: UiRequestContext,
  sessionId: string,
  request: JournalRequest,
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
    ...request.filters,
    ...(deps.dir !== undefined ? { dir: deps.dir } : {}),
    limit: JOURNAL_RECORDS_PER_PAGE,
    offset: (request.page - 1) * JOURNAL_RECORDS_PER_PAGE,
  }
  const pageData = await deps.read.searchSession(sessionId, options)
  const state = viewState(request, await agentNames(deps))
  return ok(ctx, renderSessionView(sessionId, pageData, state), {
    search: searchBox(request.filters.text),
    navMeta: `page ${request.page}`,
  })
}

/** The `Records` tab: every session's records as one stream, same ceilings as a search. */
async function renderRecordsTab(
  deps: JournalHandlerDeps,
  ctx: UiRequestContext,
  request: JournalRequest,
): Promise<UiResult> {
  const result = await deps.read.searchAllSessions(crossSessionOptions(deps, request.filters))
  const state = viewState(request, await agentNames(deps))
  const shown = result.hits.length
  return ok(ctx, renderAllRecords(result, state), {
    search: searchBox(request.filters.text),
    navMeta: `${shown} ${shown === 1 ? 'record' : 'records'}`,
  })
}

async function renderSearch(
  deps: JournalHandlerDeps,
  ctx: UiRequestContext,
  request: JournalRequest,
): Promise<UiResult> {
  const result = await deps.read.searchAllSessions(crossSessionOptions(deps, request.filters))
  const state = viewState(request, await agentNames(deps))
  const hits = result.hits.length
  return ok(ctx, renderCrossSessionSearch(result, state), {
    search: searchBox(request.filters.text),
    navMeta: `${hits} ${hits === 1 ? 'hit' : 'hits'}`,
  })
}

function crossSessionOptions(
  deps: JournalHandlerDeps,
  filters: JournalFilters,
): CrossSessionSearchOptions {
  return { ...filters, ...(deps.dir !== undefined ? { dir: deps.dir } : {}) }
}

/**
 * The agent dropdown's options. A registry that cannot be read must not take
 * the page down with it: the filter is still typed into the URL, the list is
 * simply empty.
 */
async function agentNames(deps: JournalHandlerDeps): Promise<readonly string[]> {
  if (deps.listAgentNames === undefined) return []
  try {
    return await deps.listAgentNames()
  } catch {
    return []
  }
}

function viewState(request: JournalRequest, names: readonly string[]): JournalViewState {
  return {
    ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
    filters: request.filters,
    page: request.page,
    month: request.month,
    pickerOpen: request.pickerOpen,
    today: request.today,
    agentNames: names,
    ...(request.view !== undefined ? { view: request.view } : {}),
  }
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
