import { html, type Html, join } from '../html.js'
import type { SessionSummaryEntry } from '../../journal/index-cache.js'
import type {
  CrossSessionHit,
  CrossSessionSearchResult,
  JournalFilters,
  SessionPage,
} from '../../journal/search.js'
import type { JournalRecord } from '../../journal/record.js'

/**
 * Server-rendered markup for the journal browser (M4 Task 15). Every function
 * returns pre-escaped `Html` built through the `html` tagged template — the
 * only sanctioned path to markup — because everything shown here is untrusted:
 * journal payloads are read back off disk where a forged file could carry
 * anything, and tool names / decision fields originate from a proxied server.
 *
 * These functions are pure: they take already-fetched data (from the read
 * layer the handler owns) and turn it into markup. Cost ceilings, filter
 * parsing and session-id validation live in the handler.
 */

/** The current filter/paging state, echoed into the filter form and links. */
export interface JournalViewState {
  readonly sessionId?: string
  readonly filters: JournalFilters
  readonly page: number
}

// --- Session list ---------------------------------------------------------

/** Renders the paginated session list (newest activity first, order preserved). */
export function renderSessionList(
  sessions: readonly SessionSummaryEntry[],
  page: number,
  pageCount: number,
): Html {
  if (sessions.length === 0) {
    return html`<section class="journal">
      ${renderSearchForm({ filters: {}, page: 1 })}
      <p class="empty">No sessions in the journal yet.</p>
    </section>`
  }
  const rows = join(sessions.map(renderSessionRow))
  return html`<section class="journal">
    <h1>Journal</h1>
    ${renderSearchForm({ filters: {}, page: 1 })}
    <table class="sessions">
      <thead><tr><th>Session</th><th>Records</th><th>Unreadable</th><th>First</th><th>Last</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${renderPager('/journal', page, pageCount)}
  </section>`
}

function renderSessionRow(entry: SessionSummaryEntry): Html {
  const href = `/journal?session=${encodeURIComponent(entry.sessionId)}`
  return html`<tr>
    <td><a href="${href}">${entry.sessionId}</a></td>
    <td>${entry.count}</td>
    <td>${renderSkipped(entry.skippedLineCount)}</td>
    <td>${entry.firstTs}</td>
    <td>${entry.lastTs}</td>
  </tr>`
}

// --- Single session -------------------------------------------------------

/** Renders one page of a session's records with its filter form and pager. */
export function renderSessionView(
  sessionId: string,
  pageData: SessionPage,
  state: JournalViewState,
): Html {
  const rows =
    pageData.records.length === 0
      ? html`<p class="empty">No records match the current filters.</p>`
      : join(pageData.records.map(renderRecord))
  const baseHref = `/journal?session=${encodeURIComponent(sessionId)}`
  return html`<section class="journal session">
    <h1>Session ${sessionId}</h1>
    ${renderSearchForm(state)}
    ${renderSessionScanNotice(pageData)}
    <div class="records">${rows}</div>
    ${renderPager(baseHref, state.page, state.page + (pageData.hasMore ? 1 : 0))}
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

/** Renders one journal record; `decision` records get a dedicated layout. */
function renderRecord(record: JournalRecord): Html {
  if (record.kind === 'decision' && record.decision !== undefined) {
    return renderDecision(record)
  }
  return html`<article class="record ${record.kind}">
    <header>
      <span class="ts">${record.ts}</span>
      <span class="direction">${record.direction}</span>
      <span class="method">${record.method ?? ''}</span>
    </header>
    <pre class="payload">${stringifyPayload(record.payload)}</pre>
  </article>`
}

/**
 * A decision record: outcome, rule and (when present) a link to the approval
 * resolution. The approvals feed lives at `/`; the approval id is carried as a
 * fragment so an operator lands on the resolution context.
 */
function renderDecision(record: JournalRecord): Html {
  const d = record.decision
  if (d === undefined) return html``
  const approval =
    d.approvalId !== undefined
      ? html` · <a href="/#approval-${encodeURIComponent(d.approvalId)}">approval ${d.approvalId}</a>`
      : html``
  return html`<article class="record decision">
    <header>
      <span class="ts">${record.ts}</span>
      <span class="outcome">${d.outcome}</span>
      <span class="tool">${d.serverName} · ${d.toolName}</span>
      <span class="class">${d.toolClass}</span>
    </header>
    <p class="rule">rule: ${d.rule}${approval}</p>
  </article>`
}

// --- Cross-session search -------------------------------------------------

/** Renders cross-session search results with an honest truncation banner. */
export function renderCrossSessionSearch(
  result: CrossSessionSearchResult,
  state: JournalViewState,
): Html {
  const hits =
    result.hits.length === 0
      ? html`<p class="empty">No matching records.</p>`
      : join(result.hits.map(renderHit))
  return html`<section class="journal search">
    <h1>Journal search</h1>
    ${renderSearchForm(state)}
    ${renderTruncationBanner(result)}
    <p class="scan-notice">${renderSkipped(result.skippedLineCount)} unreadable line(s) skipped.</p>
    <div class="records">${hits}</div>
  </section>`
}

function renderHit(hit: CrossSessionHit): Html {
  const href = `/journal?session=${encodeURIComponent(hit.sessionId)}`
  return html`<article class="hit">
    <a class="session-link" href="${href}">${hit.sessionId}</a>
    ${renderRecord(hit.record)}
  </article>`
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
  return html`<section class="journal error">
    <h1>Journal</h1>
    <p class="error">Invalid session id: it must match [A-Za-z0-9_-] and name a real session.</p>
    <p><a href="/journal">Back to the session list</a></p>
  </section>`
}

/** Renders the filter/search form, echoing the current state into the fields. */
function renderSearchForm(state: JournalViewState): Html {
  const f = state.filters
  const sessionField =
    state.sessionId !== undefined
      ? html`<input type="hidden" name="session" value="${state.sessionId}">`
      : html``
  return html`<form class="filters" method="GET" action="/journal">
    ${sessionField}
    <input type="search" name="q" value="${f.text ?? ''}" placeholder="text">
    <input type="text" name="kind" value="${f.kind ?? ''}" placeholder="kind">
    <input type="text" name="direction" value="${f.direction ?? ''}" placeholder="direction">
    <input type="text" name="method" value="${f.method ?? ''}" placeholder="method">
    <input type="text" name="tool" value="${f.toolName ?? ''}" placeholder="tool">
    <input type="text" name="outcome" value="${f.outcome ?? ''}" placeholder="outcome">
    <button type="submit">Filter</button>
  </form>`
}

/** Prev/next pager over a 1-based page number. */
function renderPager(baseHref: string, page: number, pageCount: number): Html {
  const sep = baseHref.includes('?') ? '&' : '?'
  const prev =
    page > 1
      ? html`<a class="prev" href="${baseHref}${sep}page=${page - 1}">Prev</a>`
      : html`<span class="prev disabled">Prev</span>`
  const next =
    page < pageCount
      ? html`<a class="next" href="${baseHref}${sep}page=${page + 1}">Next</a>`
      : html`<span class="next disabled">Next</span>`
  return html`<nav class="pager">${prev}<span class="page">Page ${page}</span>${next}</nav>`
}

/** Shows an unreadable-line count, emphasised when non-zero (never hidden). */
function renderSkipped(count: number): Html {
  return count > 0 ? html`<strong class="skipped">${count}</strong>` : html`${0}`
}

/** JSON-stringifies a payload for display; non-serializable payloads degrade safely. */
function stringifyPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload, null, 2) ?? ''
  } catch {
    return '[unserializable payload]'
  }
}
