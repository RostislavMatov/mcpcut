import type { InventoryStoreData } from '../../policy/inventory-store.js'
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_OK,
} from '../constants.js'
import { headerValue, parseBodyFields, type UiHandler, type UiRequestContext, type UiResult } from '../routes.js'
import { renderQuarantinePage, toQuarantineCards } from '../pages/quarantine.js'
import type { UiSession } from '../auth.js'

/**
 * Quarantine action + page handlers (M4 Task 12). The page renders the
 * structural `inputSchema` diff (see `pages/quarantine.ts`); approve/reject are
 * attributed mutations. The inventory store has no actor field of its own, so
 * attribution is carried through the injectable `audit` sink (wired to the
 * journal by the coordinator) and — always — by requiring an authenticated
 * `adminName`: a handler with no session refuses rather than mutating
 * unattributed.
 */

export type QuarantineAction = 'approve' | 'reject'

export interface QuarantineAuditEvent {
  readonly action: QuarantineAction
  readonly serverName: string
  readonly toolName: string
  readonly adminName: string
}

export interface QuarantineHandlerDeps {
  /** Reads the current inventory store (approved + quarantined for every server). */
  readonly readStore: () => Promise<InventoryStoreData>
  /** Approves a quarantined tool; `false` when it was not quarantined. */
  readonly approve: (serverName: string, toolName: string) => Promise<boolean>
  /** Rejects (discards) a quarantined tool; `false` when it was not quarantined. */
  readonly reject: (serverName: string, toolName: string) => Promise<boolean>
  /** Optional attribution sink invoked on every successful mutation. */
  readonly audit?: (event: QuarantineAuditEvent) => void
}

export interface QuarantineHandlers {
  readonly quarantinePage: UiHandler
  readonly quarantineApprove: UiHandler
  readonly quarantineReject: UiHandler
}

function jsonResult(status: number, payload: unknown): UiResult {
  return { kind: 'response', status, body: Buffer.from(JSON.stringify(payload), 'utf8') }
}

function currentAdminOf(session: UiSession | undefined): { name: string; role: string } | undefined {
  return session === undefined ? undefined : { name: session.adminName, role: session.role }
}

async function renderPage(deps: QuarantineHandlerDeps, ctx: UiRequestContext): Promise<UiResult> {
  const store = await deps.readStore()
  const currentAdmin = currentAdminOf(ctx.session)
  const html = renderQuarantinePage({
    cards: toQuarantineCards(store),
    csrfToken: ctx.session?.csrfToken ?? '',
    ...(currentAdmin !== undefined ? { currentAdmin } : {}),
  })
  return { kind: 'response', status: HTTP_STATUS_OK, body: html }
}

/** Shared approve/reject action, keyed by which store mutation to run. */
async function mutateAction(
  deps: QuarantineHandlerDeps,
  ctx: UiRequestContext,
  action: QuarantineAction,
): Promise<UiResult> {
  const session = ctx.session
  if (session === undefined) {
    return jsonResult(HTTP_STATUS_FORBIDDEN, { status: 'forbidden', message: 'Not authenticated.' })
  }
  const fields = parseBodyFields(ctx.body, headerValue(ctx.headers, 'content-type'))
  const serverName = fields.server
  const toolName = fields.tool
  if (serverName === undefined || serverName === '' || toolName === undefined || toolName === '') {
    return jsonResult(HTTP_STATUS_BAD_REQUEST, {
      status: 'error',
      message: 'Both "server" and "tool" are required.',
    })
  }
  const mutate = action === 'approve' ? deps.approve : deps.reject
  const changed = await mutate(serverName, toolName)
  if (!changed) {
    return jsonResult(HTTP_STATUS_NOT_FOUND, {
      status: 'not-quarantined',
      message: `"${toolName}" is not quarantined for server "${serverName}".`,
    })
  }
  deps.audit?.({ action, serverName, toolName, adminName: session.adminName })
  return jsonResult(HTTP_STATUS_OK, { status: 'ok', action, serverName, toolName })
}

/** Factory: binds the quarantine handlers to the inventory store operations. */
export function createQuarantineHandlers(deps: QuarantineHandlerDeps): QuarantineHandlers {
  return {
    quarantinePage: (ctx) => renderPage(deps, ctx),
    quarantineApprove: (ctx) => mutateAction(deps, ctx, 'approve'),
    quarantineReject: (ctx) => mutateAction(deps, ctx, 'reject'),
  }
}
