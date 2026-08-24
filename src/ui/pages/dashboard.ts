import type { ServerRecord } from '../../registry/schema.js'
import type { JournalRecord } from '../../journal/record.js'
import { html, join, safeUrl, type Html } from '../html.js'
import {
  pendingTotalOf,
  renderQueueRegion,
  type ApprovalsPageInput,
} from './approval-queue.js'
import { renderCallDetail, renderJournalPanel, selectDecision } from './dashboard-parts.js'
import { renderLayout } from './layout.js'

/**
 * The dashboard served at `/`, laid out exactly as Dashboard.dc.html of the
 * McpCut design: four sparkline tiles, then the call journal table (left)
 * beside the approval queue and the call-detail card (right), and the servers
 * grid along the bottom. Filtering (`?server=`) and row selection (`?sel=`)
 * are plain GET parameters, so the whole page works without JavaScript.
 *
 * Everything beyond the queue is OPTIONAL: `summary` is absent when the
 * handler was composed without the summary ports (tests, or a reduced
 * deployment), and the page then degrades to the queue alone — exactly the
 * M4 approvals page. Every value shown is untrusted-for-render (registry,
 * inventory, journal, agents store) and reaches markup only through the
 * escaping `html` template.
 */

/** One recent decision projected for the dashboard journal panel. */
export interface RecentDecisionView {
  readonly id: string
  readonly ts: string
  readonly sessionId: string
  readonly serverName: string
  readonly toolName: string
  readonly outcome: string
  readonly rule: string
  readonly agentName?: string
  readonly argsHash?: string
  readonly durationMs?: number
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
  /** `?server=` — journal filter; used only when it names a registered server. */
  readonly journalServer?: string
  /** `?sel=` — journal row backing the detail panel; defaults to the newest. */
  readonly selectedId?: string
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
      id: record.id,
      ts: record.ts,
      sessionId,
      serverName: d.serverName ?? '',
      toolName: d.toolName,
      outcome: d.outcome,
      rule: d.rule,
      ...(d.agentName !== undefined ? { agentName: d.agentName } : {}),
      ...(d.argsHash !== undefined ? { argsHash: d.argsHash } : {}),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    })
  }
  return out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)).slice(0, limit)
}

/**
 * Sparkline geometry: bars per tile, the number of height buckets defined as
 * `.tb-h0`…`.tb-h7` in `css/page-dashboard.ts`, how many trailing bars render
 * solid white, and one wave seed per tile (the design's values). Heights are
 * a deterministic sine wave — decoration, not data — so the render is stable
 * for tests and identical on every load.
 */
const TILE_BAR_COUNT = 16
const TILE_BAR_BUCKETS = 8
const TILE_BAR_LIT = 4
const TILE_SEEDS = [0.7, 2.1, 1.3, 0.4] as const

function tileBars(seed: number): Html {
  const bars: Html[] = []
  for (let i = 0; i < TILE_BAR_COUNT; i++) {
    const wave = Math.abs(Math.sin((i + 1) * seed))
    const bucket = Math.min(TILE_BAR_BUCKETS - 1, Math.floor(wave * TILE_BAR_BUCKETS))
    const lit = i >= TILE_BAR_COUNT - TILE_BAR_LIT ? ' on' : ''
    bars.push(html`<span class="tb tb-h${String(bucket)}${lit}"></span>`)
  }
  return html`<span class="tile-bars" aria-hidden="true">${join(bars)}</span>`
}

function tile(
  label: string,
  value: string,
  unit: string,
  href: string,
  strong: boolean,
  seed: number,
): Html {
  const cls = strong ? 'tile tile-strong' : 'tile'
  return html`<a class="${cls}" href="${safeUrl(href)}">
    <span class="label">${label}</span>
    <span class="tile-row"><span class="tile-value num">${value}</span><span class="tile-unit">${unit}</span></span>
    ${tileBars(seed)}
  </a>`
}

function renderTiles(input: DashboardPageInput): Html {
  const held = pendingTotalOf(input)
  const s = input.summary
  const heldTile = tile('Held', String(held), 'awaiting approval', '/', held > 0, TILE_SEEDS[0])
  if (s === undefined) return html`<section class="tiles dash-tiles">${heldTile}</section>`
  return html`<section class="tiles dash-tiles">
    ${heldTile}
    ${tile('Quarantined', String(s.quarantinedCount), `${s.approvedToolCount} tools approved`, '/quarantine', s.quarantinedCount > 0, TILE_SEEDS[1])}
    ${tile('Servers', String(s.servers.length), 'registered', '/servers', false, TILE_SEEDS[2])}
    ${tile('Agents', String(s.agentsActive), `of ${s.agentsTotal} active`, '/agents', false, TILE_SEEDS[3])}
  </section>`
}

/** Width buckets of the per-server activity bar (`.svw-0`…`.svw-7`). */
const SERVER_BAR_MAX_BUCKET = 7

function renderServerCell(
  record: ServerRecord,
  quarantined: ReadonlySet<string>,
  decisions: readonly RecentDecisionView[],
): Html {
  const calls = decisions.filter((d) => d.serverName === record.name).length
  const flagged = quarantined.has(record.name)
  const dot = flagged ? 'dot dot-off dot-blink' : 'dot'
  const target = record.transport === 'stdio' ? record.command : record.url
  const width = `svw-${String(Math.min(calls, SERVER_BAR_MAX_BUCKET))}`
  return html`<a class="dash-server" href="${safeUrl('/servers')}">
    <span class="row"><span class="${dot}"></span><span class="name ellipsis">${record.name}</span></span>
    <span class="muted small ellipsis">${String(calls)} calls · ${record.transport} · ${target}</span>
    <span class="sv-bar"><span class="${width}"></span></span>
  </a>`
}

function renderServersStrip(s: DashboardSummary): Html {
  const cells =
    s.servers.length === 0
      ? html`<p class="empty">No servers registered.</p>`
      : html`<div class="dash-servers">${join(s.servers.map((r) => renderServerCell(r, s.quarantinedServers, s.recentDecisions)))}</div>`
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

/** The filter is honoured only when it names a registered server (fails open to ALL). */
function validatedFilter(input: DashboardPageInput, s: DashboardSummary): string | undefined {
  const f = input.journalServer
  if (f === undefined) return undefined
  return s.servers.some((r) => r.name === f) ? f : undefined
}

function renderMain(input: DashboardPageInput, s: DashboardSummary): Html {
  const filter = validatedFilter(input, s)
  const shown =
    filter === undefined ? s.recentDecisions : s.recentDecisions.filter((d) => d.serverName === filter)
  const selected = selectDecision(shown, input.selectedId)
  const journal = renderJournalPanel({
    decisions: shown,
    total: s.recentDecisions.length,
    servers: s.servers,
    ...(filter !== undefined ? { filter } : {}),
    ...(selected !== undefined ? { selectedId: selected.id } : {}),
    truncated: s.recentTruncated,
  })
  return html`<section class="dash-grid">
      ${journal}
      <div class="dash-side">
        ${renderQueuePanel(input)}
        ${renderCallDetail(selected)}
      </div>
    </section>`
}

/** Renders the full dashboard document (string ready for the HTTP body). */
export function renderDashboardPage(input: DashboardPageInput): string {
  const s = input.summary
  const body =
    s === undefined
      ? html`${renderTiles(input)}${renderQueuePanel(input)}`
      : html`${renderTiles(input)}
        ${renderMain(input, s)}
        ${renderServersStrip(s)}`
  return renderLayout({
    title: 'Dashboard',
    content: body,
    csrfToken: input.csrfToken,
    ...(input.currentAdmin !== undefined ? { currentAdmin: input.currentAdmin } : {}),
    activeNav: 'approvals',
    ...(s !== undefined
      ? {
          search: {
            action: '/',
            name: 'q',
            placeholder: 'search journal — server, tool, status',
            clientFilter: true,
          },
        }
      : {}),
  })
}
