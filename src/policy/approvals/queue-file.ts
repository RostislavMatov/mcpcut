import type { ToolClass } from '../schema.js'

/**
 * On-disk file format of the approvals queue (`approvals/queue.ts`): the
 * shapes persisted to `pending/<id>.json` and `resolved/<id>.json`, plus
 * their hand-written validators. Split out of `queue.ts` purely for the
 * <400-line file rule — `queue.ts` re-exports everything here, so importers
 * see one module. The validators are deliberately hand-written (not zod):
 * the M4 fields are optional, and files written by pre-M4 versions must
 * keep parsing forever.
 */

/** Every outcome an operator can record via `resolve()`. */
export const RESOLVE_OUTCOME_VALUES = ['approved', 'denied'] as const
export type ResolveOutcome = (typeof RESOLVE_OUTCOME_VALUES)[number]

/**
 * Every outcome that can end up in a resolved file. Adds `expired` to
 * `ResolveOutcome`: `markExpired()` (session teardown) records a resolution
 * an operator never made, so it gets its own outcome rather than being
 * force-fit into `denied`.
 */
export const RESOLUTION_OUTCOME_VALUES = [...RESOLVE_OUTCOME_VALUES, 'expired'] as const
export type ResolutionOutcome = (typeof RESOLUTION_OUTCOME_VALUES)[number]

/**
 * Shape persisted to `pending/<approvalId>.json`. `expiresAt` is the end of
 * the GRANT window (`grantTtlMs`); the three optional fields are M4 additions
 * for the admin UI — files written before them still parse (`list()` reads
 * both generations), and `waitExpiresAt` (end of the agent's own wait,
 * `timeoutMs`) tells an operator whether an approval delivers the call now
 * or only grants a retry.
 */
export interface PendingApprovalFile {
  readonly approvalId: string
  readonly serverName: string
  readonly toolName: string
  readonly toolClass: ToolClass
  readonly argsRedacted: unknown
  readonly argsHash: string
  readonly sessionId: string
  readonly requestedAt: string
  readonly expiresAt: string
  readonly agentName?: string
  readonly waitExpiresAt?: string
  readonly decisionRule?: string
}

/** `list()` entry: a pending file plus a derived, not-persisted `expired` flag. */
export interface PendingApproval extends PendingApprovalFile {
  readonly expired: boolean
}

/** The resolution half of a resolved file: what `readResolution()` returns. */
export interface ApprovalResolution {
  readonly outcome: ResolutionOutcome
  readonly actor?: string
  readonly reason?: string
  readonly resolvedAt: string
}

/** Shape persisted to `resolved/<approvalId>.json`: the pending fields plus a resolution. */
export type ResolvedApprovalFile = PendingApprovalFile & {
  readonly resolution: Omit<ApprovalResolution, 'resolvedAt'>
  readonly resolvedAt: string
}

function isToolClass(value: unknown): value is ToolClass {
  return value === 'read' || value === 'write' || value === 'destructive'
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

/** Hand-written shape check: the M4 fields are optional, so pre-M4 files still pass. */
export function isPendingApprovalFile(raw: unknown): raw is PendingApprovalFile {
  if (typeof raw !== 'object' || raw === null) return false
  const value = raw as Record<string, unknown>
  return (
    typeof value.approvalId === 'string' &&
    typeof value.serverName === 'string' &&
    typeof value.toolName === 'string' &&
    isToolClass(value.toolClass) &&
    typeof value.argsHash === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.requestedAt === 'string' &&
    typeof value.expiresAt === 'string' &&
    isOptionalString(value.agentName) &&
    isOptionalString(value.waitExpiresAt) &&
    isOptionalString(value.decisionRule)
  )
}

function isResolutionOutcome(value: unknown): value is ResolutionOutcome {
  return (RESOLUTION_OUTCOME_VALUES as readonly unknown[]).includes(value)
}

export function isResolvedApprovalFile(raw: unknown): raw is ResolvedApprovalFile {
  if (!isPendingApprovalFile(raw)) return false
  const value = raw as unknown as Record<string, unknown>
  const resolution = value.resolution
  return (
    typeof value.resolvedAt === 'string' &&
    typeof resolution === 'object' &&
    resolution !== null &&
    isResolutionOutcome((resolution as Record<string, unknown>).outcome)
  )
}
