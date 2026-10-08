import type { StateDatabase } from '../store-backend.js'
import {
  bumpChangeSeq,
  openApprovalsDb,
  resolvePendingRow,
  runWriteTransaction,
  selectPendingDoc,
  selectResolvedDoc,
} from './queue-db.js'
import {
  isPendingApprovalFile,
  isResolvedApprovalFile,
  parseDoc,
  type ApprovalResolution,
  type PendingApprovalFile,
  type ResolvedApprovalFile,
} from './queue-file.js'
import { deleteHeartbeat } from './queue-heartbeat-db.js'

/**
 * The one write that settles a pending request, shared by every resolver of
 * the queue: an operator's `resolve()`, the gate's `withdraw()` and
 * `markExpired()`, and the lazy sweep. Split out of `queue.ts` for the
 * <400-line file rule when decision M36 added the withdrawal.
 *
 * Per row: the pending record is read and the conditional `UPDATE … WHERE
 * status = 'pending'` written under the same `BEGIN IMMEDIATE`, so of two
 * concurrent resolvers of one id exactly one observes it as pending — an
 * approve racing a withdrawal has exactly one winner. The heartbeat of the row
 * (`queue-heartbeat-db.ts`) goes in the same transaction, so a pending request
 * and its heartbeat start and end together.
 */

/** Approval ids are ULIDs; validated before ever reaching a query parameter. */
const APPROVAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export type ResolveResult =
  | { readonly ok: true; readonly record: ResolvedApprovalFile }
  | { readonly ok: false; readonly reason: 'not-found-or-already-resolved' }
  /**
   * The agent stopped waiting before this resolution landed (M36): nothing was
   * sent, and nothing will be. Says when and why, so the operator is told what
   * happened instead of hunting for a request that "does not exist".
   */
  | {
      readonly ok: false
      readonly reason: 'withdrawn'
      readonly withdrawnAt: string
      readonly withdrawnReason: string
    }

/** The single refusal every unresolvable id gets: unknown, invalid, already settled, or malformed. */
export const NOT_RESOLVABLE = {
  ok: false,
  reason: 'not-found-or-already-resolved',
} as const satisfies ResolveResult

/**
 * True when `approvalId` has the safe shape the queue accepts. Exported so
 * callers can reject a malformed id at their own boundary (the UI action
 * handler does) instead of only learning about it as a failed resolve.
 */
export function isValidApprovalId(approvalId: string): boolean {
  return APPROVAL_ID_PATTERN.test(approvalId)
}

/** Builds the resolution half of a record from the pending one, inside the write transaction. */
export type BuildResolution = (pending: PendingApprovalFile) => Omit<ApprovalResolution, 'resolvedAt'>

export interface QueueResolver {
  /** Settles a whole batch in ONE transaction, in order, with a result per valid input id. */
  moveToResolvedBatch(approvalIds: readonly string[], build: BuildResolution): Promise<ResolveResult[]>
  /** One id through the batch: an unknown, already resolved, invalid or malformed id is refused. */
  moveToResolved(approvalId: string, build: BuildResolution): Promise<ResolveResult>
}

/**
 * Why a row could not be settled: a withdrawal says so (the operator is told
 * when and why the agent left); everything else is the one generic refusal.
 */
function refusalFor(database: StateDatabase, approvalId: string): ResolveResult {
  const text = selectResolvedDoc(database, approvalId)
  const settled = text === null ? null : parseDoc(text, isResolvedApprovalFile)
  if (settled === null || settled.resolution.outcome !== 'withdrawn') return NOT_RESOLVABLE
  return {
    ok: false,
    reason: 'withdrawn',
    withdrawnAt: settled.resolvedAt,
    withdrawnReason: settled.resolution.reason ?? '',
  }
}

export function createQueueResolver(baseDir: string, clock: () => number): QueueResolver {
  async function moveToResolvedBatch(
    approvalIds: readonly string[],
    build: BuildResolution,
  ): Promise<ResolveResult[]> {
    const targets = approvalIds.filter(isValidApprovalId)
    if (targets.length === 0) return []
    const db = await openApprovalsDb(baseDir)

    return runWriteTransaction(db, (database): ResolveResult[] => {
      // The clock is read INSIDE the transaction, once the writer lock is
      // held: `resolvedAt` (and the expiry downgrade built from the same
      // moment) then describe when the resolution actually lands. One instant
      // for the batch, because the batch commits as one instant.
      const resolvedAt = new Date(clock()).toISOString()
      return targets.map((approvalId) => settleOne(database, approvalId, resolvedAt, build))
    })
  }

  async function moveToResolved(approvalId: string, build: BuildResolution): Promise<ResolveResult> {
    const [result] = await moveToResolvedBatch([approvalId], build)
    return result ?? NOT_RESOLVABLE
  }

  return { moveToResolvedBatch, moveToResolved }
}

/**
 * One row of a batch. A row that cannot be read is refused, not rolled back
 * onto the rest: one unreadable record must not cost the whole pass.
 */
function settleOne(
  database: StateDatabase,
  approvalId: string,
  resolvedAt: string,
  build: BuildResolution,
): ResolveResult {
  const text = selectPendingDoc(database, approvalId)
  const pending = text === null ? null : parseDoc(text, isPendingApprovalFile)
  // A malformed pending record is as unresolvable as a missing one: it must
  // never be listed, approved, or downgraded.
  if (pending === null) return text === null ? refusalFor(database, approvalId) : NOT_RESOLVABLE

  const record: ResolvedApprovalFile = { ...pending, resolution: build(pending), resolvedAt }
  const won = resolvePendingRow(database, {
    approvalId,
    doc: JSON.stringify(record),
    outcome: record.resolution.outcome,
    resolvedAt,
    changeSeq: bumpChangeSeq(database),
  })
  // Unreachable while the row is read and written under one write lock; kept
  // as the defence in depth that owns the "one winner" invariant.
  if (!won) return NOT_RESOLVABLE
  deleteHeartbeat(database, approvalId)
  return { ok: true, record }
}
