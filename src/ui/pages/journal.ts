import { html, type Html, join, safeUrl } from '../html.js'
import type { SessionSummaryEntry } from '../../journal/index-cache.js'
import type { CrossSessionSearchResult, SessionPage } from '../../journal/search.js'
import {
  hasLatency,
  renderFilterForm,
  renderPager,
  renderRecordRows,
  renderSkipped,
  sessionHref,
  type JournalViewState,
  type RecordRowOptions,
} from './journal-parts.js'

export type { JournalViewState } from './journal-parts.js'

/**
 * Server-rendered markup for the journal browser (M4 Task 15, McpCut front
 * 2026-08-22). Three views — the session list, one session's records, and a
 * cross-session text search — each a `.panel` in the design's "Call journal"
 * language: caps header row, hair-line rows, payload behind a disclosure.
 *
 * Every function returns pre-escaped `Html` built through the `html` tagged
 * template — the only sanctioned path to markup — because everything shown is
 * untrusted: payloads are read back off disk where a forged file could carry
 * anything, and tool names / decision fields originate from a proxied server.
 * The functions are pure: cost ceilings, filter parsing and session-id
 * validation live in the handler. The honest accounting (scan notices,
 * truncation banners, unreadable counts) is preserved verbatim.
 */

// --- Session list ---------------------------------------------------------

/** Renders the paginated session list (newest activity first, order preserved). */
export function renderSessionList(
  sessions: readonly SessionSummaryEntry[],
  page: number,
  pageCount: number,
  total: number,
): Html {
  const body =
    sessions.length === 0
      ? html`<p class="empty">No sessions in the journal yet.</p>`
      : html`<div class="jr-row jr-row-hd jr-session label"><span>Session</span><span class="num">Records</span><span class="num">Unreadable</span><span>First</span><span>Last</span></div>
        <div class="jr-rows">${join(sessions.map(renderSessionRow))}</div>`
  return html`<section class="panel jr-panel" aria-label="Call journal">
    <div class="panel-hd"><h1>Call journal</h1><span class="small muted num">${total} sessions</span></div>
    <div class="jr-filter-bar">${renderFilterForm({ filters: {}, page: 1 })}</div>
    ${body}
    <div class="panel-ft">${renderPager('/journal', page, pageCount)}<span class="num">${sessions.length} shown</span></div>
  </section>`
}

function renderSessionRow(entry: SessionSummaryEntry): Html {
  return html`<a class="jr-row jr-session" href="${safeUrl(sessionHref(entry.sessionId))}">
    <span class="ellipsis jr-session-id">${entry.sessionId}</span>
    <span class="num">${entry.count}</span>
    <span class="num">${renderSkipped(entry.skippedLineCount)}</span>
    <span class="muted num ellipsis">${entry.firstTs}</span>
    <span class="muted num ellipsis">${entry.lastTs}</span>
  </a>`
}

// --- Single session -------------------------------------------------------

/** Renders one page of a session's records with its filter form and pager. */
export function renderSessionView(
  sessionId: string,
  pageData: SessionPage,
  state: JournalViewState,
): Html {
  const options: RecordRowOptions = { hasLatency: hasLatency(pageData.records), withSession: false }
  const rows = renderRecordRows(
    pageData.records.map((record) => ({ record })),
    options,
    'No records match the current filters.',
  )
  const pageCount = state.page + (pageData.hasMore ? 1 : 0)
  return html`<section class="${panelClass(options)}" aria-label="Session records">
    <div class="panel-hd"><h1>Session ${sessionId}</h1><span class="small muted num">page ${state.page}</span></div>
    <div class="jr-filter-bar">${renderFilterForm(state)}</div>
    <div class="jr-notices">${renderSessionScanNotice(pageData)}</div>
    ${rows}
    <div class="panel-ft">${renderPager(sessionHref(sessionId), state.page, pageCount)}<span class="num">${pageData.records.length} shown</span></div>
  </section>`
}

/** Honest scan accounting for one session page: unreadable lines and truncation. */
function renderSessionScanNotice(pageData: SessionPage): Html {
  const truncated = pageData.truncated
    ? html`<p class="notice truncated">Scan stopped at the ${pageData.scannedLineCount}-line
        ceiling — this view may be incomplete (truncated).</p>`
    : html``
  return html`<p class="scan-notice">Scanned ${pageData.scannedLineCount} lines;
    ${renderSkipped(pageData.skippedLineCount)} unreadable.</p>${truncated}`
}

// --- Cross-session search -------------------------------------------------

/** Renders cross-session search results with an honest truncation banner. */
export function renderCrossSessionSearch(
  result: CrossSessionSearchResult,
  state: JournalViewState,
): Html {
  const records = result.hits.map((hit) => hit.record)
  const options: RecordRowOptions = { hasLatency: hasLatency(records), withSession: true }
  const rows = renderRecordRows(result.hits, options, 'No matching records.')
  return html`<section class="${panelClass(options)}" aria-label="Journal search">
    <div class="panel-hd"><h1>Journal search</h1><span class="small muted num">${result.hits.length} hit(s)</span></div>
    <div class="jr-filter-bar">${renderFilterForm(state)}</div>
    <div class="jr-notices">${renderTruncationBanner(result)}
    <p class="scan-notice">${renderSkipped(result.skippedLineCount)} unreadable line(s) skipped.</p></div>
    ${rows}
  </section>`
}

/**
 * The honest truncation notice: an audit product must say "scanned N of M
 * files, stopped by <reason>" rather than present a partial answer as whole.
 */
function renderTruncationBanner(result: CrossSessionSearchResult): Html {
  if (!result.truncated) {
    return html`<p class="notice complete">Scanned all ${result.filesTotal} session file(s).</p>`
  }
  return html`<p class="notice truncated">Search stopped early: scanned
    ${result.filesScanned} of ${result.filesTotal} file(s), stopped by
    ${result.stoppedBy ?? 'limit'}. Results are incomplete (truncated).</p>`
}

// --- Shared bits ----------------------------------------------------------

/** Invalid/unsafe session id → a clean, non-reflecting error fragment. */
export function renderInvalidSession(): Html {
  return html`<section class="panel jr-panel" aria-label="Journal">
    <div class="panel-hd"><h1>Journal</h1></div>
    <div class="jr-notices">
      <p class="notice error">Invalid session id: it must match [A-Za-z0-9_-] and name a real session.</p>
      <p><a href="/journal">Back to the session list</a></p>
    </div>
  </section>`
}

/** The record-list panel class; `jr-has-lat` switches the row grid to the latency template. */
function panelClass(options: RecordRowOptions): string {
  const lat = options.hasLatency ? ' jr-has-lat' : ''
  const session = options.withSession ? ' jr-with-session' : ''
  return `panel jr-panel${lat}${session}`
}
