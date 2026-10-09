import { MAX_APPROVAL_ACTOR_CHARS } from '../constants.js'
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
 * Every outcome that can end up in a resolved record. Adds two outcomes no
 * operator makes to `ResolveOutcome`, each with its own name rather than being
 * force-fit into `denied`: `expired` (the request outlived its own expiry, or a
 * capped wait ran out) and `withdrawn` (decision M36: the agent stopped
 * waiting — it cancelled, disconnected, or the process holding the request was
 * lost — so nothing was sent; `resolution.reason` says which, see
 * `withdraw.ts`).
 */
export const RESOLUTION_OUTCOME_VALUES = [...RESOLVE_OUTCOME_VALUES, 'expired', 'withdrawn'] as const
export type ResolutionOutcome = (typeof RESOLUTION_OUTCOME_VALUES)[number]

/**
 * Shape of a request awaiting a decision. `expiresAt` is the hard cap on how
 * long the request stays approvable (decision M36: 24 h, or the policy's
 * `approval.timeoutMs` when that is shorter; before M36 it was the end of a
 * grant window). The three optional M4 fields are additions for the admin UI —
 * records written before them still parse (`list()` reads both generations);
 * `waitExpiresAt` is present only when the policy capped the agent's wait.
 *
 * `policyHash`/`grantsHash` are the M5 pair: the fingerprint of the rules in
 * force WHEN THE REQUEST WAS MADE (`policy/provenance.ts`), so a resolution
 * recorded minutes later can be traced to the revision it was requested
 * under rather than to whatever is in force at resolution time. Optional for
 * the same reason as the M4 fields: pre-M5 records must keep parsing.
 * `grantsHash` is absent — not null — when no agent was behind the request
 * (the `wrap` path), the convention `agentName` already follows.
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
  readonly policyHash?: string
  readonly grantsHash?: string
}

/**
 * `list()` entry: a pending record plus derived, not-persisted flags.
 * `agentConnected` is true while the process holding the call refreshes its
 * heartbeat (M36); it is ABSENT for a request that has no heartbeat at all — one
 * an older build enqueued — because "unknown" and "gone" are different facts.
 */
export interface PendingApproval extends PendingApprovalFile {
  readonly expired: boolean
  readonly agentConnected?: boolean
  /**
   * When the process holding the call last checked in (its heartbeat), present
   * only while `agentConnected` is false: the operator is told since when the
   * agent has been silent, and that an approval now would send nothing.
   */
  readonly holderSeenAt?: string
}

/**
 * The resolution half of a resolved record: what `readResolution()` returns.
 *
 * `actor` names WHO recorded the resolution (`cli`, `ui:<adminName>`) and is
 * ABSENT — not null, not empty — whenever no human made it. The `expired`
 * paths (`queue.ts`'s `markExpired()` for a capped wait that ran out, and the
 * lazy sweep's `markExpiredBatch()`) and every `withdrawn` one (the agent
 * left, M36) deliberately carry none: those resolutions are recorded by the
 * process itself, and inventing an actor for them would put a person's name
 * on a decision they never made. A `withdrawn` resolution's `reason` says why
 * the agent left (`withdraw.ts`). So "no actor" reads as a FACT ABOUT THE OUTCOME, not as
 * missing data — which is what lets the journal (M5 wave 2) treat an
 * attributed record and an unattributed one as two different claims rather
 * than as one claim with a gap.
 *
 * The one `expired` resolution that CAN carry an actor is the downgrade in
 * `resolve()`: an operator answered a request that had already passed its
 * `expiresAt`, and their name is kept for the audit trail even though the
 * answer no longer authorizes anything.
 */
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

/** A lowercase hex SHA-256 digest — the same shape `agents/schema.ts` pins `tokenHash` to. */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

/**
 * A digest field is validated as a DIGEST, not merely as a string (SEC-L2).
 * Every other digest in the codebase is regex-pinned, and these two are what
 * waves 3-5 will chain and sign: a row written out of band could otherwise
 * carry a 10 MB string or markup and have `list()` accept it as evidence.
 * Absent stays legal — pre-M5 records must keep parsing forever — but
 * present-and-not-a-digest is rejected like any other malformed field, which
 * skips the record whole rather than reading past the bad value.
 */
function isOptionalSha256Hex(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && SHA256_HEX_PATTERN.test(value))
}

/**
 * `actor` is validated as an OPTIONAL, LENGTH-CAPPED string (M5 wave 2). It
 * was previously not validated at all — `isResolvedApprovalFile` checked only
 * the outcome — while being read straight out of untrusted stored text. It is
 * about to become signed evidence of who authorized a destructive operation,
 * so it gets the same treatment `isOptionalSha256Hex` gives the provenance
 * digests: absent stays legal forever (an `expired` resolution has no actor,
 * and pre-M5 records may have none either), present-and-wrong skips the
 * record whole rather than reading past the bad value.
 */
export function isOptionalActor(value: unknown): boolean {
  if (value === undefined) return true
  return typeof value === 'string' && value.length <= MAX_APPROVAL_ACTOR_CHARS
}

/**
 * Thrown when a caller tries to STORE an actor the reader above would reject.
 * A programming error in a producer, not an operator mistake, so it is an
 * exception rather than a `ResolveResult` — the only two `ResolveResult`
 * failures mean "not found or already resolved", and reporting this as one of
 * those would send an operator hunting for a request that is sitting right
 * there.
 */
export class ApprovalActorTooLongError extends Error {
  constructor(length: number) {
    super(
      `approval actor is ${length} characters, exceeding the ${MAX_APPROVAL_ACTOR_CHARS}-character cap; ` +
        `a resolution stored with it could not be read back`,
    )
    this.name = 'ApprovalActorTooLongError'
  }
}

/**
 * The WRITE-side half of the actor contract, deliberately adjacent to the
 * read-side `isOptionalActor` so the two caps come from one constant and
 * cannot drift apart (M5 wave-2 review, finding 3).
 *
 * Validating on read alone let an over-cap actor be accepted and persisted,
 * after which every reader rejected the whole record: the waiting agent never
 * saw the decision and timed out, so an APPROVED request behaved as
 * unresolved with no diagnostic anywhere. Failing loudly at the boundary turns that silent evidence loss
 * into a stack trace at the call site that caused it. Deliberately not a
 * truncation: a repaired attribution is a fabricated one, and this field is
 * about to be signed.
 */
export function assertStorableActor(actor: string | undefined): void {
  if (actor === undefined) return
  if (!isOptionalActor(actor)) throw new ApprovalActorTooLongError(actor.length)
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

/** Hand-written shape check: the M4/M5 fields are optional, so older records still pass. */
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
    isOptionalString(value.decisionRule) &&
    isOptionalSha256Hex(value.policyHash) &&
    isOptionalSha256Hex(value.grantsHash)
  )
}

/**
 * "Expired" is `now >= expiresAt` — the expiry INSTANT is already expired — on
 * EVERY path that judges a record (the list, the resolve and the sweep), so an
 * operator can never see a request as live that `resolve()` would downgrade (or
 * vice versa), and the sweep can never expire a request the other two consider
 * live. An unparseable timestamp cannot reach here (`isPendingApprovalFile`
 * rejects it, review H2) but is treated as already expired anyway: fail closed
 * twice.
 */
export function isExpiredAt(expiresAt: string, nowMs: number): boolean {
  const expiresAtMs = Date.parse(expiresAt)
  return Number.isNaN(expiresAtMs) || nowMs >= expiresAtMs
}

/**
 * When nothing could deliver an approval of this request any more: the agent's
 * capped wait (`waitExpiresAt`) or the request's own cap, whichever is first.
 * Fixed-width UTC ISO timestamps, so string order is time order.
 */
export function deliveryEndsAt(record: PendingApprovalFile): string {
  const { waitExpiresAt, expiresAt } = record
  return waitExpiresAt !== undefined && waitExpiresAt < expiresAt ? waitExpiresAt : expiresAt
}

/** Parses one stored record, returning `null` for anything the validators reject. */
export function parseDoc<T>(text: string, isShape: (raw: unknown) => raw is T): T | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null // malformed JSON: skip, never throw on garbage content
  }
  return isShape(raw) ? raw : null // malformed shape: skip
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
    isResolutionOutcome((resolution as Record<string, unknown>).outcome) &&
    isOptionalActor((resolution as Record<string, unknown>).actor)
  )
}
