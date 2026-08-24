import type { ServerRecord } from '../../registry/schema.js'
import { html, join, safeUrl, type Html } from '../html.js'
import type { RecentDecisionView } from './dashboard.js'

/**
 * The journal and call-detail panels of the dashboard (Dashboard.dc.html of
 * the McpCut design): the left "Call journal" table with per-server filter
 * pills, and the right "Call detail" card fed by the `?sel=` row selection.
 * Both are pure renderers over `RecentDecisionView`s — reading and bounding
 * happened in the handler; selection and filtering are plain GET parameters so
 * the whole surface works without JavaScript. Every value shown is
 * untrusted-for-render and passes through the escaping `html` template; hrefs
 * go through `safeUrl`.
 */

export interface JournalPanelInput {
  /** Rows after the server filter, newest first. */
  readonly decisions: readonly RecentDecisionView[]
  /** Rows before the filter (the "of N" in the footer). */
  readonly total: number
  /** Registered servers — one filter pill each. */
  readonly servers: readonly ServerRecord[]
  /** Active server filter, already validated against the registry. */
  readonly filter?: string
  /** Id of the row highlighted for the detail panel. */
  readonly selectedId?: string
  /** True when the decisions walk stopped early (bounded read). */
  readonly truncated: boolean
}

/** `2026-08-22T10:00:01.000Z` → `10:00:01`; unparseable stamps pass through. */
export function shortTime(ts: string): string {
  const t = ts.indexOf('T')
  return t === -1 ? ts : ts.slice(t + 1, t + 9)
}

/** The row backing the detail panel: `?sel=` when it names a shown row, else the newest. */
export function selectDecision(
  shown: readonly RecentDecisionView[],
  selectedId: string | undefined,
): RecentDecisionView | undefined {
  if (selectedId !== undefined) {
    const hit = shown.find((d) => d.id === selectedId)
    if (hit !== undefined) return hit
  }
  return shown[0]
}

function filterPill(label: string, href: string, active: boolean): Html {
  const cls = active ? 'jf is-on' : 'jf'
  return html`<a class="${cls}" href="${safeUrl(href)}">${label}</a>`
}

function renderFilters(input: JournalPanelInput): Html {
  const pills = [
    filterPill('ALL', '/', input.filter === undefined),
    ...input.servers.map((server) =>
      filterPill(server.name, `/?server=${encodeURIComponent(server.name)}`, input.filter === server.name),
    ),
  ]
  return html`<div class="jf-row">${join(pills)}</div>`
}

function rowHref(decision: RecentDecisionView, filter: string | undefined): string {
  const query = new URLSearchParams({ sel: decision.id })
  if (filter !== undefined) query.set('server', filter)
  return `/?${query.toString()}`
}

function renderRow(decision: RecentDecisionView, input: JournalPanelInput): Html {
  const cls = decision.id === input.selectedId ? 'dash-row is-sel' : 'dash-row'
  const lat = decision.durationMs !== undefined ? `${decision.durationMs}ms` : '—'
  const filterText = `${decision.serverName}/${decision.toolName} ${decision.outcome} ${shortTime(decision.ts)}`
  return html`<a class="${cls}" href="${safeUrl(rowHref(decision, input.filter))}" title="${decision.ts}" data-filter-item data-filter-text="${filterText}">
    <span class="muted num">${shortTime(decision.ts)}</span>
    <span class="ellipsis"><span class="server">${decision.serverName}</span>/<span class="tool-name">${decision.toolName}</span></span>
    <span class="lat num">${lat}</span>
    <span class="outcome outcome-${decision.outcome} upper">${decision.outcome}</span>
  </a>`
}

function renderEmpty(input: JournalPanelInput): Html {
  if (input.total === 0) return html`<p class="empty">No decisions journalled yet.</p>`
  return html`<p class="empty">No calls match this filter.</p>`
}

function renderFooter(input: JournalPanelInput): Html {
  const note = input.truncated
    ? html`<span class="faint">read stopped early — open the journal for the rest</span>`
    : html`<span class="faint">journal retained locally</span>`
  return html`<div class="panel-ft"><span>${String(input.decisions.length)} of ${String(input.total)} calls shown</span>${note}</div>`
}

/** The left panel: header with filter pills, the column grid, rows, footer. */
export function renderJournalPanel(input: JournalPanelInput): Html {
  const rows =
    input.decisions.length === 0
      ? renderEmpty(input)
      : html`<div class="dash-rows">${join(input.decisions.map((d) => renderRow(d, input)))}</div>`
  return html`<section class="panel dash-recent" aria-label="Call journal">
    <div class="panel-hd"><h2>Call journal</h2>${renderFilters(input)}</div>
    <div class="dash-rows-hd label"><span>Time</span><span>Server / tool</span><span>Lat</span><span>Status</span></div>
    ${rows}
    <p class="empty" data-filter-empty hidden>No calls match this search.</p>
    ${renderFooter(input)}
  </section>`
}

function kv(key: string, value: string): Html {
  return html`<div class="kv-line"><span class="label">${key}</span><span class="kv-v ellipsis" title="${value}">${value}</span></div>`
}

/** The right "Call detail" panel for the selected row (or its empty state). */
export function renderCallDetail(decision: RecentDecisionView | undefined): Html {
  if (decision === undefined) {
    return html`<section class="panel dash-detail" aria-label="Call detail">
      <div class="panel-hd"><h2>Call detail</h2><span class="label">—</span></div>
      <p class="empty">Pick a row in the journal to inspect the decision behind it.</p>
    </section>`
  }
  const meta =
    decision.argsHash !== undefined
      ? `rule ${decision.rule} · args ${decision.argsHash}`
      : `rule ${decision.rule}`
  return html`<section class="panel dash-detail" aria-label="Call detail">
    <div class="panel-hd"><h2>Call detail</h2><span class="label ellipsis">${decision.id}</span></div>
    <div class="dash-detail-bd">
      <div class="kv-rows">
        ${kv('Server', decision.serverName)}
        ${kv('Tool', decision.toolName)}
        ${kv('Caller', decision.agentName ?? '—')}
        ${kv('Started', shortTime(decision.ts))}
        ${kv('Duration', decision.durationMs !== undefined ? `${decision.durationMs}ms` : '—')}
        ${kv('Status', decision.outcome.toUpperCase())}
      </div>
      <div class="detail-args num">${meta}</div>
      <a class="detail-open" href="${safeUrl(`/journal?session=${encodeURIComponent(decision.sessionId)}`)}">Open session in journal</a>
    </div>
  </section>`
}
