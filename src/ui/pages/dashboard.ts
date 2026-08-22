import type { ServerRecord } from '../../registry/schema.js'
import type { JournalRecord } from '../../journal/record.js'
import { html, join, safeUrl, type Html } from '../html.js'
import {
  pendingTotalOf,
  renderQueueRegion,
  type ApprovalsPageInput,
} from './approval-queue.js'
import { renderLayout } from './layout.js'

/**
 * The dashboard served at `/` — the Dashboard screen of the McpCut design.
 * Four tiles (held · quarantined · servers · agents), the approval queue as
 * the live panel, the most recent policy decisions from the journal, and a
 * strip of registered servers.
 *
 * Everything beyond the queue is OPTIONAL: `summary` is absent when the
 * handler was composed without the summary ports (tests, or a reduced
 * deployment), and the page then degrades to the queue alone — exactly the
 * M4 approvals page. Every value shown is untrusted-for-render (registry,
 * inventory, journal, agents store) and reaches markup only through the
 * escaping `html` template.
 */

/** One recent decision projected for the dashboard list. */
export interface RecentDecisionView {
  readonly ts: string
  readonly sessionId: string
  readonly serverName: string
  readonly toolName: string
  readonly outcome: string
  readonly rule: string
  readonly agentName?: string
}

/** Everything the dashboard shows besides the queue; built by the handler. */
export interface DashboardSummary {
  readonly servers: readonly ServerRecord[]
  /** Quarantined tools across every server (inventory store). */
  readonly quarantinedCount: number
  /** Servers that currently hold at least one quarantined tool. */
  readonly quarantinedServers: ReadonlySet<string>
  /** Approved (reviewed) tools across every server. */
  readonly approvedToolCount: number
  /** Agents with no `revokedAt`. */
  readonly agentsActive: number
  readonly agentsTotal: number
  readonly recentDecisions: readonly RecentDecisionView[]
  /** True when the decisions read stopped early (bounded walk). */
  readonly recentTruncated: boolean
}

export interface DashboardPageInput extends ApprovalsPageInput {
  readonly summary?: DashboardSummary
}

/** Projects journal decision records into the dashboard list, newest first. */
export function toRecentDecisions(
  records: readonly { readonly sessionId: string; readonly record: JournalRecord }[],
  limit: number,
): RecentDecisionView[] {
  const out: RecentDecisionView[] = []
  for (const { sessionId, record } of records) {
    const d = record.decision
    if (record.kind !== 'decision' || d === undefined) continue
    out.push({
      ts: record.ts,
      sessionId,
      serverName: d.serverName ?? '',
      toolName: d.toolName,
      outcome: d.outcome,
      rule: d.rule,
      ...(d.agentName !== undefined ? { agentName: d.agentName } : {}),
    })
  }
  return out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)).slice(0, limit)
}

function tile(label: string, value: string, unit: string, href: string, strong: boolean): Html {
  const cls = strong ? 'tile tile-strong' : 'tile'
  return html`<a class="${cls}" href="${safeUrl(href)}">
    <span class="label">${label}</span>
    <span class="tile-row"><span class="tile-value num">${value}</span><span class="tile-unit">${unit}</span></span>
    <span class="tile-bars" aria-hidden="true"></span>
  </a>`
}

function renderTiles(input: DashboardPageInput): Html {
  const held = pendingTotalOf(input)
  const s = input.summary
  const heldTile = tile('Held', String(held), 'awaiting approval', '/', held > 0)
  if (s === undefined) return html`<section class="tiles dash-tiles">${heldTile}</section>`
  return html`<section class="tiles dash-tiles">
    ${heldTile}
    ${tile('Quarantined', String(s.quarantinedCount), `${s.approvedToolCount} tools approved`, '/quarantine', s.quarantinedCount > 0)}
    ${tile('Servers', String(s.servers.length), 'registered', '/servers', false)}
    ${tile('Agents', String(s.agentsActive), `of ${s.agentsTotal} active`, '/agents', false)}
  </section>`
}

function shortTime(ts: string): string {
  const t = ts.indexOf('T')
  return t === -1 ? ts : ts.slice(t + 1, t + 9)
}

function renderDecisionRow(d: RecentDecisionView): Html {
  const href = `/journal?session=${encodeURIComponent(d.sessionId)}`
  return html`<a class="dash-row" href="${safeUrl(href)}" title="${d.ts}">
    <span class="muted num">${shortTime(d.ts)}</span>
    <span class="ellipsis"><span class="server">${d.serverName}</span>/<span class="tool-name">${d.toolName}</span></span>
    <span class="muted ellipsis">${d.agentName ?? ''}</span>
    <span class="outcome outcome-${d.outcome} upper">${d.outcome}</span>
  </a>`
}

function renderRecent(s: DashboardSummary): Html {
  const rows =
    s.recentDecisions.length === 0
      ? html`<p class="empty">No decisions journalled yet.</p>`
      : join(s.recentDecisions.map(renderDecisionRow))
  const truncated = s.recentTruncated
    ? html`<span class="faint">read stopped early — open the journal for the rest</span>`
    : html`<span class="faint">newest first</span>`
  return html`<section class="panel dash-recent" aria-label="Recent decisions">
    <div class="panel-hd"><h2>Call journal</h2><a class="small" href="${safeUrl('/journal')}">open journal</a></div>
    <div class="dash-rows-hd label"><span>Time</span><span>Server / tool</span><span>Agent</span><span>Outcome</span></div>
    <div class="dash-rows">${rows}</div>
    <div class="panel-ft">${truncated}<span>${String(s.recentDecisions.length)} shown</span></div>
  </section>`
}

function renderServerCell(record: ServerRecord, quarantined: ReadonlySet<string>): Html {
  const flagged = quarantined.has(record.name)
  const dot = flagged ? 'dot dot-off dot-blink' : 'dot'
  const target = record.transport === 'stdio' ? record.command : record.url
  return html`<a class="dash-server" href="${safeUrl('/servers')}">
    <span class="row"><span class="${dot}"></span><span class="pixel ellipsis">${record.name}</span></span>
    <span class="muted small ellipsis">${record.transport} · ${target}</span>
    ${flagged ? html`<span class="pill pill-pixel pill-on shimmer">quarantined</span>` : html``}
  </a>`
}

function renderServersStrip(s: DashboardSummary): Html {
  const cells =
    s.servers.length === 0
      ? html`<p class="empty">No servers registered.</p>`
      : html`<div class="dash-servers">${join(s.servers.map((r) => renderServerCell(r, s.quarantinedServers)))}</div>`
  return html`<section class="panel" aria-label="Servers">
    <div class="panel-hd"><h2>Servers</h2><span class="small muted">${String(s.servers.length)} registered · ${String(s.quarantinedCount)} tool(s) quarantined</span></div>
    ${cells}
  </section>`
}

function renderQueuePanel(input: DashboardPageInput): Html {
  return html`<section class="panel panel-strong dash-queue" aria-label="Approval queue">
    <div class="panel-hd"><h1>Approval queue</h1><span class="small dim num">${String(pendingTotalOf(input))} held</span></div>
    ${renderQueueRegion(input)}
  </section>`
}

/** Renders the full dashboard document (string ready for the HTTP body). */
export function renderDashboardPage(input: DashboardPageInput): string {
  const s = input.summary
  const body =
    s === undefined
      ? html`${renderTiles(input)}${renderQueuePanel(input)}`
      : html`${renderTiles(input)}
        <section class="dash-grid">
          ${renderQueuePanel(input)}
          ${renderRecent(s)}
        </section>
        ${renderServersStrip(s)}`
  return renderLayout({
    title: 'Dashboard',
    content: body,
    csrfToken: input.csrfToken,
    ...(input.currentAdmin !== undefined ? { currentAdmin: input.currentAdmin } : {}),
    activeNav: 'approvals',
  })
}
