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
import type { UiSession } from '../auth.js'

/**
 * Approvals action + page handlers (M4 Task 12). The page and JSON feed are
 * read-only; approve/deny are attributed mutations: every resolution carries
 * `actor: 'ui:<adminName>'`, so the resolved file, the journal and
 * `approvals list` all name the human who decided. A resolve that loses the
 * race (already resolved by CLI or a second click) is reported as a readable
 * conflict, never a 500 — "first resolve wins" is the queue's contract.
 */

/** The queue surface these handlers need (a subset of `ApprovalQueue`). */
export type ApprovalsQueue = Pick<ApprovalQueue, 'list' | 'resolve'>

export interface ApprovalsHandlerDeps {
  readonly queue: ApprovalsQueue
  /** Clock (ms epoch) for computing remaining wait/grant seconds. Defaults to `Date.now`. */
  readonly clock?: () => number
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

/** Builds the display cards from the live queue at the handler's clock. */
async function loadCards(deps: ApprovalsHandlerDeps): Promise<ApprovalCardView[]> {
  const nowMs = (deps.clock ?? Date.now)()
  const pending = await deps.queue.list()
  return pending.map((entry) => toApprovalCard(entry, nowMs))
}

function currentAdminOf(session: UiSession | undefined): { name: string; role: string } | undefined {
  return session === undefined ? undefined : { name: session.adminName, role: session.role }
}

async function renderPage(deps: ApprovalsHandlerDeps, ctx: UiRequestContext): Promise<UiResult> {
  const cards = await loadCards(deps)
  const csrfToken = ctx.session?.csrfToken ?? ''
  const currentAdmin = currentAdminOf(ctx.session)
  const html = renderApprovalsPage({
    cards,
    csrfToken,
    ...(currentAdmin !== undefined ? { currentAdmin } : {}),
  })
  return { kind: 'response', status: HTTP_STATUS_OK, body: html }
}

async function renderApi(deps: ApprovalsHandlerDeps): Promise<UiResult> {
  return jsonResult(HTTP_STATUS_OK, { approvals: await loadCards(deps) })
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
