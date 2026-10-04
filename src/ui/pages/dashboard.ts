import type { ServerRecord } from '../../registry/schema.js'
import { targetOf } from '../../registry/target.js'
import type { JournalRecord } from '../../journal/record.js'
import { html, join, safeUrl, type Html } from '../html.js'
import {
  pendingTotalOf,
  renderQueueRegion,
  type ApprovalsPageInput,
} from './approval-queue.js'
import { renderCallDetail, renderJournalPanel, selectDecision } from './dashboard-parts.js'
import { renderLayout, type CurrentAdmin } from './layout.js'
import { roleAllows } from './role-gate.js'

/**
 * The dashboard served at `/`, laid out exactly as Dashboard.dc.html of the
 * McpCut design: four number tiles (the design's sparklines dropped 2026-09-29: decoration next to real
 * numbers read as invented activity), then the call journal table (left)
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
  /**
   * The policy turns quarantine off (ADR-0009 amendment 2026-10-02): nothing
   * is held, so the counts above are 0 and the tile says "off".
   */
  readonly quarantineOff?: true
  /** Servers in the tool inventory but not in the registry — `wrap` on this machine. */
  readonly machineServers?: readonly string[]
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

function tile(
  label: string,
  value: string,
  unit: string,
  href: string,
  strong: boolean,
  liveKey?: string,
): Html {
  const cls = strong ? 'tile tile-strong' : 'tile'
  const live = liveKey === undefined ? html`` : html` data-live-text="${liveKey}"`
  return html`<a class="${cls}" href="${safeUrl(href)}">
    <span class="label">${label}</span>
    <span class="tile-row"><span class="tile-value num"${live}>${value}</span><span class="tile-unit">${unit}</span></span>
  </a>`
}

/**
 * Off in the policy: a quiet "off" instead of a count of tools nothing holds.
 * Not "new tools pass": under a `require-approval` default they still wait.
 */
function quarantineTile(s: DashboardSummary): Html {
  return s.quarantineOff === true
    ? tile('Quarantine', 'off', 'rules still apply', '/quarantine', false)
    : tile('Quarantined', String(s.quarantinedCount), `${s.approvedToolCount} tools approved`, '/quarantine', s.quarantinedCount > 0)
}

function renderTiles(input: DashboardPageInput): Html {
  const held = pendingTotalOf(input)
  const s = input.summary
  // The Held tile is the only one a queue swap can change; the other three
  // describe registry/inventory state no approval touches.
  const heldTile = tile('Held', String(held), 'awaiting approval', '/', held > 0, TILE_HELD_LIVE_KEY)
  if (s === undefined) return html`<section class="tiles dash-tiles">${heldTile}</section>`
  return html`<section class="tiles dash-tiles">
    ${heldTile}
    ${quarantineTile(s)}
    ${tile('Servers', String(s.servers.length), 'registered', '/servers', false)}
    ${tile('Agents', String(s.agentsActive), `of ${s.agentsTotal} active`, '/agents', false)}
  </section>`
}

/** Who may register a server: the `POST /servers/add` row of `ROUTE_TABLE`. */
const SERVER_REGISTER_MIN_ROLE = 'owner'

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
  const target = targetOf(record)
  const width = `svw-${String(Math.min(calls, SERVER_BAR_MAX_BUCKET))}`
  return html`<a class="dash-server" href="${safeUrl('/servers')}">
    <span class="row"><span class="${dot}"></span><span class="name ellipsis">${record.name}</span></span>
    <span class="muted small ellipsis">${String(calls)} calls · ${record.transport} · ${target}</span>
    <span class="sv-bar"><span class="${width}"></span></span>
  </a>`
}

/** Inventory names shown on the empty strip; the rest are on `/servers`. */
const MACHINE_SERVERS_SHOWN = 5

function namesOf(names: readonly string[]): string {
  const shown = names.slice(0, MACHINE_SERVERS_SHOWN).join(', ')
  const rest = names.length - MACHINE_SERVERS_SHOWN
  return rest > 0 ? `${shown} +${String(rest)} more` : shown
}

/**
 * The empty strip names the next step (owner's rule 2026-09-29), as on
 * `/servers`: the register form for an owner — the `POST /servers/add` row's
 * threshold — and who can for anyone else.
 */
function renderNoServers(admin: CurrentAdmin | undefined, machineServers: readonly string[]): Html {
  if (machineServers.length > 0) {
    // Their calls already show up in the journal above: "register one so its
    // calls show up" would send the user to do what is already done. Worded
    // as on `/servers`: the inventory also keeps servers removed since.
    return html`<p class="empty">No servers registered. Seen in the tool inventory, not registered: ${namesOf(machineServers)} — wrap on this machine, or removed since; their tools and rules are on <a href="${safeUrl('/servers')}">Servers</a>.</p>`
  }
  return roleAllows(admin, SERVER_REGISTER_MIN_ROLE)
    ? html`<p class="empty">No servers registered. <a href="${safeUrl('/servers?add=1#add-server')}">Register a server</a> — its calls then show up here.</p>`
    : html`<p class="empty">No servers registered. An owner registers them.</p>`
}

function renderServersStrip(s: DashboardSummary, admin: CurrentAdmin | undefined): Html {
  const cells =
    s.servers.length === 0
      ? renderNoServers(admin, s.machineServers ?? [])
      : html`<div class="dash-servers">${join(s.servers.map((r) => renderServerCell(r, s.quarantinedServers, s.recentDecisions)))}</div>`
  return html`<section class="panel" aria-label="Servers">
    <div class="panel-hd"><h2>Servers</h2><span class="small muted">${String(s.servers.length)} registered · ${s.quarantineOff === true ? 'quarantine off' : `${String(s.quarantinedCount)} tool(s) quarantined`}</span></div>
    ${cells}
  </section>`
}

/**
 * The two counts that describe the queue but sit OUTSIDE its live region: the
 * panel head and the Held tile. Both carry `data-live-text`, so a settle or an
 * SSE swap of the region updates them in place instead of leaving a stale "3
 * held" over an empty queue (UX-12). The keys are the contract with
 * `assets/app-js.ts` and are pinned by `tests/ui/page-contracts.test.ts`.
 */
const QUEUE_HELD_LIVE_KEY = 'queue-held'
const TILE_HELD_LIVE_KEY = 'tile-held'

function renderQueuePanel(input: DashboardPageInput): Html {
  return html`<section class="panel panel-strong dash-queue" aria-label="Approval queue">
    <div class="panel-hd"><h1>Approval queue</h1><span class="small dim num" data-live-text="${QUEUE_HELD_LIVE_KEY}">${String(pendingTotalOf(input))} held</span></div>
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
        ${renderServersStrip(s, input.currentAdmin)}`
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
          scripts: ['dashboard.js'],
        }
      : {}),
  })
}
