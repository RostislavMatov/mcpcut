import { APPROVALS_LIST_MAX_ROWS } from '../../config.js'
import {
  isValidApprovalId,
  type ApprovalQueue,
  type ResolveOutcome,
} from '../../policy/approvals/queue.js'
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_CONFLICT,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_OK,
} from '../constants.js'
import { parseBodyFields, type UiHandler, type UiRequestContext, type UiResult } from '../routes.js'
import { headerValue } from '../routes.js'
import { renderApprovalsPage, toApprovalCard, type ApprovalCardView } from '../pages/approvals.js'
import { toRecentDecisions, type DashboardSummary } from '../pages/dashboard.js'
import type { UiSession } from '../auth.js'
import type { ServerRecord } from '../../registry/schema.js'
import type { InventoryStoreData } from '../../policy/inventory-store.js'
import type { AgentRecord } from '../../agents/schema.js'
import type { CrossSessionSearchResult } from '../../journal/search.js'

/**
 * Approvals action + page handlers (M4 Task 12). The page and JSON feed are
 * read-only; approve/deny are attributed mutations: every resolution carries
 * `actor: 'ui:<adminName>'`, so the resolved file, the journal and
 * `approvals list` all name the human who decided. A resolve that loses the
 * race (already resolved by CLI or a second click) is reported as a readable
 * conflict, never a 500 — "first resolve wins" is the queue's contract.
 */

/** The queue surface these handlers need (a subset of `ApprovalQueue`). */
export type ApprovalsQueue = Pick<ApprovalQueue, 'list' | 'resolve' | 'countPending'>

/**
 * The READ ports behind the dashboard's summary panels (McpCut redesign).
 * Every one is a read: the dashboard never mutates through them, and a
 * deployment that omits `summary` gets the queue alone (the M4 page).
 */
export interface DashboardSummaryPorts {
  readonly listServers: () => Promise<readonly ServerRecord[]>
  readonly readInventory: () => Promise<InventoryStoreData>
  readonly listAgents: () => Promise<readonly AgentRecord[]>
  /** Newest-first walk over decision records, bounded by the caller. */
  readonly recentDecisions: () => Promise<CrossSessionSearchResult>
}

/** Decisions shown on the dashboard; the journal page is the place for more. */
export const DASHBOARD_RECENT_DECISIONS = 12

export interface ApprovalsHandlerDeps {
  readonly queue: ApprovalsQueue
  /** Clock (ms epoch) for computing remaining wait/grant seconds. Defaults to `Date.now`. */
  readonly clock?: () => number
  /** Optional read ports for the dashboard panels beside the queue. */
  readonly summary?: DashboardSummaryPorts
}

export interface ApprovalsHandlers {
  readonly approvalsPage: UiHandler
  readonly approvalsApi: UiHandler
  readonly approvalsApprove: UiHandler
  readonly approvalsDeny: UiHandler
}

/** Attribution actor string for a UI resolution: `ui:<adminName>`. */
function uiActor(session: UiSession): string {
  return `ui:${session.adminName}`
}

function jsonResult(status: number, payload: unknown): UiResult {
  return { kind: 'response', status, body: Buffer.from(JSON.stringify(payload), 'utf8') }
}

/** The cards a bounded read returned, plus the true total behind them. */
interface ApprovalsView {
  readonly cards: ApprovalCardView[]
  readonly totalPending: number
  readonly truncated: boolean
}

/**
 * Builds the display cards from the live queue at the handler's clock. The read
 * is bounded (an undrained queue would otherwise make every poll a full scan),
 * so the total is fetched alongside it and the page says what it is not showing.
 *
 * `truncated` is deliberately NOT `totalPending > pending.length`. `list()` and
 * `countPending()` are separate transactions, so a request committing between
 * them can make that comparison true on a queue nowhere near truncated — the
 * identical mistake shipped in the CLI (`approvals-cmd.ts` `runList`, fixed in
 * commit f05c6d2). `list()` also drops rows that fail to parse before this
 * function ever sees them, so `pending.length` can sit BELOW the bound even on
 * a read that fetched everything there was to fetch — comparing it to
 * `totalPending` alone would then flag a fully-read, merely-partly-unparseable
 * queue as truncated. Gating on `pending.length` reaching the bound (the ONLY
 * way `list()` can legitimately be a bound-hit read, since this handler never
 * requests a custom `limit`) rules out both false positives; it does leave one
 * gap this module cannot close: a read that both hits the bound AND drops
 * malformed rows within it reports a `pending.length` that never reaches the
 * bound, so it reads as untruncated even though rows exist beyond it. Closing
 * that fully needs the queue to report its raw (pre-filter) fetch count, which
 * is out of scope here (see the review report).
 */
async function loadCards(deps: ApprovalsHandlerDeps): Promise<ApprovalsView> {
  const nowMs = (deps.clock ?? Date.now)()
  const pending = await deps.queue.list()
  const totalPending = await deps.queue.countPending()
  const truncated = pending.length >= APPROVALS_LIST_MAX_ROWS && totalPending > pending.length
  return {
    cards: pending.map((entry) => toApprovalCard(entry, nowMs)),
    totalPending,
    truncated,
  }
}

function currentAdminOf(session: UiSession | undefined): { name: string; role: string } | undefined {
  return session === undefined ? undefined : { name: session.adminName, role: session.role }
}

/**
 * Builds the summary panels from the read ports. Each source is read once;
 * a failure in any of them is the caller's (it surfaces as a 500 through the
 * server core, never as a half-rendered dashboard that looks whole).
 */
async function loadSummary(ports: DashboardSummaryPorts): Promise<DashboardSummary> {
  const [servers, inventory, agents, decisions] = await Promise.all([
    ports.listServers(),
    ports.readInventory(),
    ports.listAgents(),
    ports.recentDecisions(),
  ])
  let quarantinedCount = 0
  let approvedToolCount = 0
  const quarantinedServers = new Set<string>()
  for (const [serverName, inv] of Object.entries(inventory.servers)) {
    const q = Object.keys(inv.quarantined).length
    quarantinedCount += q
    approvedToolCount += Object.keys(inv.approved).length
    if (q > 0) quarantinedServers.add(serverName)
  }
  return {
    servers,
    quarantinedCount,
    quarantinedServers,
    approvedToolCount,
    agentsActive: agents.filter((a) => a.revokedAt === undefined).length,
    agentsTotal: agents.length,
    recentDecisions: toRecentDecisions(decisions.hits, DASHBOARD_RECENT_DECISIONS),
    recentTruncated: decisions.truncated,
  }
}

async function renderPage(deps: ApprovalsHandlerDeps, ctx: UiRequestContext): Promise<UiResult> {
  const view = await loadCards(deps)
  const summary = deps.summary !== undefined ? await loadSummary(deps.summary) : undefined
  const csrfToken = ctx.session?.csrfToken ?? ''
  const currentAdmin = currentAdminOf(ctx.session)
  const html = renderApprovalsPage({
    cards: view.cards,
    totalPending: view.totalPending,
    truncated: view.truncated,
    csrfToken,
    ...(currentAdmin !== undefined ? { currentAdmin } : {}),
    ...(summary !== undefined ? { summary } : {}),
  })
  return { kind: 'response', status: HTTP_STATUS_OK, body: html }
}

async function renderApi(deps: ApprovalsHandlerDeps): Promise<UiResult> {
  const view = await loadCards(deps)
  // `totalPending`/`truncated` travel beside the bounded array so a JSON
  // consumer sees the truncation too, instead of inferring "that is all of
  // them" from the length — or worse, inferring truncation itself from
  // `totalPending > approvals.length`, which is exactly the unsound
  // comparison this module no longer makes (see `loadCards`).
  return jsonResult(HTTP_STATUS_OK, {
    approvals: view.cards,
    totalPending: view.totalPending,
    truncated: view.truncated,
  })
}

/**
 * Shared approve/deny action. Fail-closed on a missing session (the server
 * gates the route by role, but attribution is required, so a handler with no
 * `adminName` refuses rather than writing an unattributed resolution).
 */
async function resolveAction(
  deps: ApprovalsHandlerDeps,
  ctx: UiRequestContext,
  outcome: ResolveOutcome,
): Promise<UiResult> {
  const session = ctx.session
  if (session === undefined) {
    return jsonResult(HTTP_STATUS_FORBIDDEN, { status: 'forbidden', message: 'Not authenticated.' })
  }
  const id = ctx.params.id
  if (id === undefined || id === '') {
    return jsonResult(HTTP_STATUS_BAD_REQUEST, { status: 'error', message: 'Missing approval id.' })
  }
  // Validate the SHAPE at the boundary, not just deep inside the queue: the id
  // comes straight off the URL and is used to build a file path. The queue is
  // fail-closed on its own, but a rejected id must read as a client error here
  // rather than as an indistinguishable "already resolved".
  if (!isValidApprovalId(id)) {
    return jsonResult(HTTP_STATUS_BAD_REQUEST, { status: 'error', message: 'Invalid approval id.' })
  }
  const reason = optionalReason(ctx)
  const result = await deps.queue.resolve(id, {
    outcome,
    actor: uiActor(session),
    ...(reason !== undefined ? { reason } : {}),
  })
  if (!result.ok) {
    return jsonResult(HTTP_STATUS_CONFLICT, {
      status: 'already-resolved',
      message: 'This request was already resolved (first resolve wins).',
    })
  }
  return jsonResult(HTTP_STATUS_OK, { status: 'ok', outcome: result.record.resolution.outcome })
}

/** Extracts an optional operator `reason` from the request body. */
function optionalReason(ctx: UiRequestContext): string | undefined {
  const fields = parseBodyFields(ctx.body, headerValue(ctx.headers, 'content-type'))
  const reason = fields.reason
  return reason !== undefined && reason !== '' ? reason : undefined
}

/** Factory: binds the approvals handlers to a queue and clock. */
export function createApprovalsHandlers(deps: ApprovalsHandlerDeps): ApprovalsHandlers {
  return {
    approvalsPage: (ctx) => renderPage(deps, ctx),
    approvalsApi: () => renderApi(deps),
    approvalsApprove: (ctx) => resolveAction(deps, ctx, 'approved'),
    approvalsDeny: (ctx) => resolveAction(deps, ctx, 'denied'),
  }
}
