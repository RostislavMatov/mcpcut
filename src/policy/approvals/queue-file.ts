import type { ToolClass } from '../schema.js'

/**
 * Persisted record forms of the approvals queue (`approvals/queue.ts`): the
 * shapes stored whole as JSON text in the `doc` column of the `approvals`
 * table, plus their hand-written validators. The same forms were written to
 * `pending/<id>.json` / `resolved/<id>.json` before M4.5 wave 3 and are read
 * back unchanged by the legacy import (`queue-import.ts`) — the storage
 * changed, the record did not.
 *
 * Split out of `queue.ts` purely for the <400-line file rule — `queue.ts`
 * re-exports everything here, so importers see one module. The validators are
 * deliberately hand-written (not zod): the M4 fields are optional, and records
 * written by pre-M4 versions must keep parsing forever.
 *
 * EVERY read path re-validates: a record comes back from storage as untrusted
 * text (a hand-edited legacy file, a foreign row), so a shape that does not
 * pass is skipped, never repaired and never trusted.
 */

/** Every outcome an operator can record via `resolve()`. */
export const RESOLVE_OUTCOME_VALUES = ['approved', 'denied'] as const
export type ResolveOutcome = (typeof RESOLVE_OUTCOME_VALUES)[number]

/**
 * Every outcome that can end up in a resolved record. Adds `expired` to
 * `ResolveOutcome`: `markExpired()` (session teardown) records a resolution
 * an operator never made, so it gets its own outcome rather than being
 * force-fit into `denied`.
 */
export const RESOLUTION_OUTCOME_VALUES = [...RESOLVE_OUTCOME_VALUES, 'expired'] as const
export type ResolutionOutcome = (typeof RESOLUTION_OUTCOME_VALUES)[number]

/**
 * Shape of a request awaiting a decision. `expiresAt` is the end of
 * the GRANT window (`grantTtlMs`); the three optional fields are M4 additions
 * for the admin UI — records written before them still parse (`list()` reads
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

/** `list()` entry: a pending record plus a derived, not-persisted `expired` flag. */
export interface PendingApproval extends PendingApprovalFile {
  readonly expired: boolean
}

/** The resolution half of a resolved record: what `readResolution()` returns. */
export interface ApprovalResolution {
  readonly outcome: ResolutionOutcome
  readonly actor?: string
  readonly reason?: string
  readonly resolvedAt: string
}

/** Shape of a settled request: the pending fields plus a resolution. */
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

/**
 * A timestamp field must actually PARSE (review H2): these records are
 * hand-editable (a legacy file, a foreign row), `Date.parse(garbage)` is
 * `NaN`, and every comparison against `NaN` is `false` — which made a garbage
 * `expiresAt` behave as "never expires" on the resolve path. A record whose
 * timestamps cannot be read is rejected whole, so it can neither be listed
 * nor resolved.
 */
function isParseableTimestamp(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isParseableTimestamp(value)
}

/** Hand-written shape check: the M4 fields are optional, so pre-M4 records still pass. */
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
    isParseableTimestamp(value.requestedAt) &&
    isParseableTimestamp(value.expiresAt) &&
    isOptionalString(value.agentName) &&
    isOptionalTimestamp(value.waitExpiresAt) &&
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
    isParseableTimestamp(value.resolvedAt) &&
    typeof resolution === 'object' &&
    resolution !== null &&
    isResolutionOutcome((resolution as Record<string, unknown>).outcome)
  )
}
