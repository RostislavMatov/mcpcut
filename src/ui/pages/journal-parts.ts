import { html, type Html, join, safeUrl } from '../html.js'
import type { JournalRecord } from '../../journal/record.js'
import type { JournalFilters } from '../../journal/search.js'

/**
 * Building blocks of the journal browser in the McpCut "Call journal" row
 * grammar: a 10px tracked-caps header row, hair-line rows with hover, and one
 * `<details class="disclosure">` per record whose summary IS the row and whose
 * body is the redacted payload. Everything here is pure and escaped through
 * the `html` template — journal values come off disk and from proxied servers
 * and are untrusted-for-render.
 */

/** The current filter/paging state, echoed into the filter form and links. */
export interface JournalViewState {
  readonly sessionId?: string
  readonly filters: JournalFilters
  readonly page: number
}

/** Per-list rendering options: latency column and session-link prefix. */
export interface RecordRowOptions {
  /** True when at least one record on the page carries `durationMs`. */
  readonly hasLatency: boolean
  /** True in cross-session search: each row leads with a session link. */
  readonly withSession: boolean
}

/** Outcomes whose pill is drawn in the alert weight (white rule). */
const ALERT_OUTCOMES: ReadonlySet<string> = new Set([
  'deny',
  'denied-by-operator',
  'quarantined',
  'timeout',
])

/** True when any record on the page carries a measured latency. */
export function hasLatency(records: readonly JournalRecord[]): boolean {
  return records.some((r) => r.durationMs !== undefined)
}

/** `HH:MM:SS` out of an ISO timestamp; anything else is shown whole. */
export function shortTime(ts: string): string {
  const t = ts.indexOf('T')
  return t === -1 ? ts : ts.slice(t + 1, t + 9)
}

export function sessionHref(sessionId: string): string {
  return `/journal?session=${encodeURIComponent(sessionId)}`
}

// --- Header row -----------------------------------------------------------

/** The caps header above a record list; mirrors the row grid of the options. */
export function renderRecordsHeader(options: RecordRowOptions): Html {
  const session = options.withSession ? html`<span>Session</span>` : html``
  const lat = options.hasLatency ? html`<span>Lat</span>` : html``
  return html`<div class="jr-row jr-row-hd label">${session}<span>Time</span><span>Message</span><span>State</span>${lat}</div>`
}

// --- Records --------------------------------------------------------------

/** One journal record as a disclosure row; `decision` records get the decision layout. */
export function renderRecordRow(
  record: JournalRecord,
  options: RecordRowOptions,
  sessionId?: string,
): Html {
  const isDecision = record.kind === 'decision' && record.decision !== undefined
  const cls = isDecision ? 'disclosure jr-rec jr-decision' : `disclosure jr-rec jr-kind-${record.kind}`
  const summary = isDecision ? decisionCells(record) : trafficCells(record)
  return html`<details class="${cls}">
    <summary class="jr-row jr-record">${sessionCell(options, sessionId)}${timeCell(record)}${summary}${latCell(record, options)}</summary>
    <div class="jr-rec-bd">${decisionDetail(record)}<pre class="payload">${stringifyPayload(record.payload)}</pre></div>
  </details>`
}

function sessionCell(options: RecordRowOptions, sessionId: string | undefined): Html {
  if (!options.withSession) return html``
  const id = sessionId ?? ''
  return html`<a class="session-link ellipsis" href="${safeUrl(sessionHref(id))}">${id}</a>`
}

function timeCell(record: JournalRecord): Html {
  return html`<span class="muted num jr-time" title="${record.ts}">${shortTime(record.ts)}</span>`
}

function latCell(record: JournalRecord, options: RecordRowOptions): Html {
  if (!options.hasLatency) return html``
  return record.durationMs !== undefined
    ? html`<span class="jr-lat num">${String(record.durationMs)} ms</span>`
    : html`<span class="jr-lat faint">—</span>`
}

/** Message + state cells of a traffic (non-decision) record. */
function trafficCells(record: JournalRecord): Html {
  return html`<span class="ellipsis jr-what"><span class="direction dim">${record.direction}</span> <span class="method">${record.method ?? ''}</span></span>
      <span class="jr-state"><span class="pill jr-kind">${record.kind}</span></span>`
}

/** Message + state cells of a decision record: `server/tool · agent` and class/outcome pills. */
function decisionCells(record: JournalRecord): Html {
  const d = record.decision
  if (d === undefined) return html``
  const agent = d.agentName !== undefined ? html` <span class="muted jr-agent">· ${d.agentName}</span>` : html``
  const outcomeCls = ALERT_OUTCOMES.has(d.outcome) ? 'pill pill-alert jr-outcome' : 'pill jr-outcome'
  return html`<span class="ellipsis jr-what"><span class="server">${d.serverName}</span>/<span class="tool-name">${d.toolName}</span>${agent}</span>
      <span class="jr-state"><span class="pill jr-class">${d.toolClass}</span> <span class="${outcomeCls}">${d.outcome}</span></span>`
}

/**
 * The rule line of a decision and, when present, the link to its approval
 * resolution: the approvals feed lives at `/` and the id rides as a fragment so
 * an operator lands on the resolution context. Empty for traffic records.
 */
function decisionDetail(record: JournalRecord): Html {
  const d = record.decision
  if (record.kind !== 'decision' || d === undefined) return html``
  const approval =
    d.approvalId !== undefined
      ? html` · <a href="/#approval-${encodeURIComponent(d.approvalId)}">approval ${d.approvalId}</a>`
      : html``
  return html`<p class="rule small">rule: ${d.rule}${approval}</p>`
}

/** A list of records as rows, with its header; `sessionOf` supplies the prefix link per record. */
export function renderRecordRows(
  entries: readonly { readonly record: JournalRecord; readonly sessionId?: string }[],
  options: RecordRowOptions,
  emptyText: string,
): Html {
  if (entries.length === 0) return html`<p class="empty">${emptyText}</p>`
  const rows = join(entries.map((e) => renderRecordRow(e.record, options, e.sessionId)))
  return html`${renderRecordsHeader(options)}<div class="jr-rows">${rows}</div>`
}

// --- Filters, pager, shared bits --------------------------------------------

/**
 * The in-panel filter form. It is a real GET to `/journal` and carries EVERY
 * field (including `q` and the hidden `session`) so a filtered view can be
 * narrowed further — the top-bar search box submits only `q` and so resets
 * the rest, which is fine for a fresh search but not for refinement.
 */
export function renderFilterForm(state: JournalViewState): Html {
  const f = state.filters
  const sessionField =
    state.sessionId !== undefined
      ? html`<input type="hidden" name="session" value="${state.sessionId}">`
      : html``
  return html`<form class="filters jr-filters" method="get" action="/journal">
    ${sessionField}
    <input type="search" name="q" value="${f.text ?? ''}" placeholder="text" aria-label="Text">
    <input type="text" name="kind" value="${f.kind ?? ''}" placeholder="kind" aria-label="Kind">
    <input type="text" name="direction" value="${f.direction ?? ''}" placeholder="direction" aria-label="Direction">
    <input type="text" name="method" value="${f.method ?? ''}" placeholder="method" aria-label="Method">
    <input type="text" name="tool" value="${f.toolName ?? ''}" placeholder="tool" aria-label="Tool">
    <input type="text" name="outcome" value="${f.outcome ?? ''}" placeholder="outcome" aria-label="Outcome">
    <button type="submit" class="secondary">Filter</button>
  </form>`
}

/** Prev/next pager over a 1-based page number. */
export function renderPager(baseHref: string, page: number, pageCount: number): Html {
  const sep = baseHref.includes('?') ? '&' : '?'
  const prev =
    page > 1
      ? html`<a class="prev" href="${safeUrl(`${baseHref}${sep}page=${page - 1}`)}">Prev</a>`
      : html`<span class="prev disabled">Prev</span>`
  const next =
    page < pageCount
      ? html`<a class="next" href="${safeUrl(`${baseHref}${sep}page=${page + 1}`)}">Next</a>`
      : html`<span class="next disabled">Next</span>`
  return html`<nav class="pager">${prev}<span class="page">Page ${page}</span>${next}</nav>`
}

/** Shows an unreadable-line count, emphasised when non-zero (never hidden). */
export function renderSkipped(count: number): Html {
  return count > 0 ? html`<strong class="skipped">${count}</strong>` : html`${0}`
}

/** JSON-stringifies a payload for display; non-serializable payloads degrade safely. */
export function stringifyPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload, null, 2) ?? ''
  } catch {
    return '[unserializable payload]'
  }
}
