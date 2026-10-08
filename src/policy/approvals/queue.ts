import { join } from 'node:path'
import { ulid } from 'ulid'
import { APPROVALS_LIST_MAX_ROWS, JOURNAL_DIR } from '../../config.js'
import { redact } from '../../redact/redact.js'
import { APPROVAL_HEARTBEAT_STALE_MS } from '../constants.js'
import { canonicalJson, sha256Hex } from '../hash.js'
import {
  bumpChangeSeq,
  insertPendingRow,
  openApprovalsDb,
  runWriteTransaction,
  countPendingRows,
  selectNewestResolvedDocs,
  selectPendingDocs,
  selectResolvedDoc,
} from './queue-db.js'
import {
  currentHolder,
  isFreshHeartbeat,
  isHolderLost,
  probeHolderLiveness,
  type HoldRecord,
} from './holder.js'
import { readChangesSince } from './queue-changes.js'
import { insertHold, refreshHeartbeats } from './queue-holds-db.js'
import { createQueueResolver, isValidApprovalId, withdrawnRefusal, type ResolveResult } from './queue-resolve.js'
import { pruneRetention } from './queue-retention.js'

/**
 * The approvals queue: one row per request in the `approvals` table of
 * `state.db` (wave 3 of M4.5; the shapes it stores are unchanged, see
 * `queue-file.ts`). Each record is kept whole as JSON text in the `doc`
 * column and re-validated on the way out, so a hand-written or foreign row is
 * skipped rather than trusted, exactly as an unparseable file was.
 *
 * `resolve()`'s correctness rests on the conditional `UPDATE … WHERE
 * status = 'pending'` inside `BEGIN IMMEDIATE` (see `queue-resolve.ts`): it is
 * the single serialization point that the file-based queue got from
 * `rename()`, so of two concurrent resolvers — two operators, or an operator
 * and the gate withdrawing a call its agent left (M36) — exactly one wins.
 *
 * `baseDir` is by contract the `approvals/` SUBDIRECTORY of a journal
 * directory: the database lives beside it, in its parent
 * (`<journalDir>/state.db`), shared with the document stores.
 *
 * Call arguments are stored **only redacted**: these records are
 * operator-facing (an approver reads one to decide, and the CLI prints it),
 * so they follow the same "redact before it can be seen" rule as the journal
 * itself. Redaction and hashing happen before the write transaction opens.
 */

const APPROVALS_SUBDIR = 'approvals'

// The persisted record shapes and their validators live in `queue-file.ts`
// (split for the <400-line file rule); re-exported so importers see one module.
export {
  RESOLVE_OUTCOME_VALUES,
  deliveryEndsAt,
  RESOLUTION_OUTCOME_VALUES,
  isPendingApprovalFile,
  isResolvedApprovalFile,
  type ApprovalResolution,
  type PendingApproval,
  type PendingApprovalFile,
  type ResolutionOutcome,
  type ResolveOutcome,
  type ResolvedApprovalFile,
} from './queue-file.js'
export { isValidApprovalId, type ResolveResult } from './queue-resolve.js'
import { sweepPending } from './queue-sweep.js'
import {
  assertStorableActor,
  deliveryEndsAt,
  isExpiredAt,
  isPendingApprovalFile,
  isResolvedApprovalFile,
  parseDoc,
  type ApprovalResolution,
  type PendingApproval,
  type PendingApprovalFile,
  type ResolutionOutcome,
  type ResolvedApprovalFile,
} from './queue-file.js'
import { WITHDRAW_REASON_PROCESS_LOST } from './withdraw.js'

export type {
  ApprovalChanges,
  ApprovalQueue,
  ApprovalQueueOptions,
  BoundedReadOptions,
  EnqueueRequest,
  EnqueueResult,
  ListResolvedOptions,
  ResolveInput,
} from './queue-types.js'
import type {
  ApprovalChanges,
  ApprovalQueue,
  ApprovalQueueOptions,
  BoundedReadOptions,
  EnqueueRequest,
  EnqueueResult,
  ListResolvedOptions,
  ResolveInput,
} from './queue-types.js'


/** A caller-supplied bound, clamped to a positive integer no larger than the default. */
function boundedLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isInteger(requested) || requested <= 0) {
    return APPROVALS_LIST_MAX_ROWS
  }
  return Math.min(requested, APPROVALS_LIST_MAX_ROWS)
}

/** Creates an approvals queue rooted at `opts.baseDir` (default `JOURNAL_DIR/approvals`). */
export function createApprovalQueue(opts: ApprovalQueueOptions = {}): ApprovalQueue {
  const baseDir = opts.baseDir ?? join(JOURNAL_DIR, APPROVALS_SUBDIR)
  const clock = opts.clock ?? Date.now
  const holder = opts.holder ?? currentHolder()
  const liveness = opts.holderLiveness ?? probeHolderLiveness
  const { moveToResolvedBatch, moveToResolved } = createQueueResolver(baseDir, clock)
  const isLostAt = (approvalId: string, hold: HoldRecord | undefined, nowMs: number): boolean =>
    isHolderLost(approvalId, hold, nowMs, liveness)

  async function enqueue(req: EnqueueRequest): Promise<EnqueueResult> {
    const approvalId = ulid()
    const argsForHashing = req.args ?? null
    const argsHash = sha256Hex(canonicalJson(argsForHashing))
    const nowMs = clock()
    // Built (and redacted) outside the transaction: the writer lock is held
    // for the insert alone.
    const record = pendingRecordOf(req, approvalId, argsHash, redact(argsForHashing), nowMs)

    const db = await openApprovalsDb(baseDir)
    await runWriteTransaction(db, (database) => {
      insertPendingRow(database, {
        approvalId,
        doc: JSON.stringify(record),
        serverName: record.serverName,
        toolName: record.toolName,
        argsHash: record.argsHash,
        requestedAt: record.requestedAt,
        expiresAt: record.expiresAt,
        changeSeq: bumpChangeSeq(database),
      })
      // The request is held from this instant (M36), by this process (R3).
      insertHold(database, approvalId, record.requestedAt, holder)
    })
    pruneRetention(db, nowMs)
    return { approvalId, argsHash }
  }

  /**
   * Both lazy sweeps (`queue-sweep.ts`), on the reads whose truthfulness is at
   * stake: a request past its own expiry, and one whose holder stopped beating.
   */
  async function sweep(nowMs: number): Promise<void> {
    await sweepPending({
      baseDir,
      nowMs,
      markExpiredBatch,
      staleBeforeIso: new Date(nowMs - APPROVAL_HEARTBEAT_STALE_MS).toISOString(),
      isLost: (approvalId, hold) => isLostAt(approvalId, hold, nowMs),
      withdrawLostBatch,
    })
  }

  async function list(listOpts: BoundedReadOptions = {}): Promise<PendingApproval[]> {
    const nowMs = clock()
    // Expiry must not depend on session lifetime (see `queue-sweep.ts`):
    // settled HERE, so what follows lists live work only. Rows the bounded
    // pass missed stay pending, and are still reported as `expired` below.
    await sweep(nowMs)
    const db = await openApprovalsDb(baseDir)
    // Ordered by the query (oldest request first); `expired` and
    // `agentConnected` are derived here rather than stored, so neither can go
    // stale in storage.
    return selectPendingDocs(db.handle.db, boundedLimit(listOpts.limit)).flatMap((row) => {
      const record = parseDoc(row.doc, isPendingApprovalFile)
      if (record === null) return []
      const expired = isExpiredAt(record.expiresAt, nowMs)
      if (row.hold === undefined) return [{ ...record, expired }]
      return [{ ...record, expired, agentConnected: isHoldLive(record.approvalId, row.hold, nowMs) }]
    })
  }

  /**
   * The lazy sweep's write (`queue-sweep.ts`): a bounded batch of already
   * identified pending ids, expired in one transaction. Returns how many rows
   * this pass actually settled — a row somebody else resolved first keeps that
   * decision and is simply not counted.
   */
  async function markExpiredBatch(approvalIds: readonly string[]): Promise<number> {
    const results = await moveToResolvedBatch(approvalIds, () => ({ outcome: 'expired' }))
    return results.filter((result) => result.ok).length
  }

  /** Held right now: a fresh heartbeat, or a holder that still runs (a stale beat after sleep, R3). */
  function isHoldLive(approvalId: string, hold: HoldRecord, nowMs: number): boolean {
    return isFreshHeartbeat(hold.heartbeatAt, nowMs) || liveness(hold.holder, approvalId) === 'alive'
  }

  /** The heartbeat sweep's write: requests whose holder died, withdrawn as `process-lost`. */
  async function withdrawLostBatch(approvalIds: readonly string[]): Promise<number> {
    const results = await moveToResolvedBatch(approvalIds, () => ({
      outcome: 'withdrawn',
      reason: WITHDRAW_REASON_PROCESS_LOST,
    }))
    return results.filter((result) => result.ok).length
  }

  /**
   * Records an operator resolution, judged against what can still be
   * delivered (review R5), under the write lock:
   *
   *  - the holder is gone (stale heartbeat, dead pid): nobody can be answered,
   *    so the row settles as `withdrawn`/`process-lost` and the operator gets
   *    the same refusal a withdrawal by the agent gives;
   *  - an `approved` past the request's `expiresAt` (the 24-hour cap) or past
   *    the agent's capped wait (`waitExpiresAt`) is DOWNGRADED to `expired`
   *    (the operator's `actor`/`reason` are preserved for the audit trail), so
   *    no `approved` resolution is ever persisted that nothing will deliver. A
   *    `denied` on such a request is harmless and is recorded as-is.
   */
  // `async` so the guard below REJECTS rather than throwing synchronously out
  // of a `Promise`-returning function: every other failure of this API is
  // asynchronous, and a caller written as `queue.resolve(...).catch(...)`
  // would otherwise see this one escape uncaught.
  async function resolve(approvalId: string, resolution: ResolveInput): Promise<ResolveResult> {
    // Before ANY write: an actor the reader would reject must never become a
    // stored record. Throwing here costs one refused call; storing it costs a
    // resolution nothing can read back (see `assertStorableActor`).
    assertStorableActor(resolution.actor)
    // `buildResolution` runs inside the write transaction, so this clock read
    // happens under the held lock, in the same instant as `resolvedAt`.
    const result = await moveToResolved(approvalId, (pending, hold) => {
      const nowMs = clock()
      if (isLostAt(pending.approvalId, hold, nowMs)) return { outcome: 'withdrawn', reason: WITHDRAW_REASON_PROCESS_LOST }
      const outcome: ResolutionOutcome =
        isPastDelivery(pending, nowMs) && resolution.outcome === 'approved' ? 'expired' : resolution.outcome
      return {
        outcome,
        ...(resolution.actor !== undefined ? { actor: resolution.actor } : {}),
        ...(resolution.reason !== undefined ? { reason: resolution.reason } : {}),
      }
    })
    return result.ok && result.record.resolution.outcome === 'withdrawn' ? withdrawnRefusal(result.record) : result
  }

  function markExpired(approvalId: string): Promise<ResolveResult> {
    return moveToResolved(approvalId, () => ({ outcome: 'expired' }))
  }

  function withdraw(approvalId: string, reason: string): Promise<ResolveResult> {
    return moveToResolved(approvalId, () => ({ outcome: 'withdrawn', reason }))
  }

  async function heartbeat(approvalIds: readonly string[]): Promise<void> {
    const valid = approvalIds.filter(isValidApprovalId)
    if (valid.length === 0) return
    const db = await openApprovalsDb(baseDir)
    const atIso = new Date(clock()).toISOString()
    await runWriteTransaction(db, (database) => refreshHeartbeats(database, valid, atIso))
  }

  async function readResolution(approvalId: string): Promise<ApprovalResolution | null> {
    if (!isValidApprovalId(approvalId)) return null

    const db = await openApprovalsDb(baseDir)
    const text = selectResolvedDoc(db.handle.db, approvalId)
    if (text === null) return null // still pending or unknown id
    const record = parseDoc(text, isResolvedApprovalFile)
    if (record === null) return null // malformed shape or content

    return {
      outcome: record.resolution.outcome,
      ...(record.resolution.actor !== undefined ? { actor: record.resolution.actor } : {}),
      ...(record.resolution.reason !== undefined ? { reason: record.resolution.reason } : {}),
      resolvedAt: record.resolvedAt,
    }
  }

  /** See `ApprovalQueue.listResolved`: bounded read of the newest entries only. */
  async function listResolved(listOpts: ListResolvedOptions): Promise<ResolvedApprovalFile[]> {
    if (!Number.isInteger(listOpts.limit) || listOpts.limit <= 0) return []

    const db = await openApprovalsDb(baseDir)
    // A malformed record among the newest is skipped, not backfilled from
    // older ones: the read stays bounded by `limit`.
    return selectNewestResolvedDocs(db.handle.db, listOpts.limit)
      .map((text) => parseDoc(text, isResolvedApprovalFile))
      .filter((record): record is ResolvedApprovalFile => record !== null)
  }

  async function countPending(): Promise<number> {
    // Swept on the same terms as `list()`: this count is the UI badge, and
    // both reads sweeping alike is what keeps a page render (list, then count)
    // from showing cards it then calls not pending.
    await sweep(clock())
    const db = await openApprovalsDb(baseDir)
    return countPendingRows(db.handle.db)
  }

  /** See `ApprovalQueue.changesSince` (`queue-changes.ts`). */
  async function changesSince(
    sinceSeq: number | null,
    changeOpts: BoundedReadOptions = {},
  ): Promise<ApprovalChanges> {
    const db = await openApprovalsDb(baseDir)
    return readChangesSince(db.handle.db, sinceSeq, boundedLimit(changeOpts.limit), clock())
  }

  return {
    enqueue,
    list,
    countPending,
    resolve,
    markExpired,
    withdraw,
    heartbeat,
    readResolution,
    listResolved,
    changesSince,
  }
}

/** The pending record of a new request, as `enqueue` stores it. */
function pendingRecordOf(
  req: EnqueueRequest,
  approvalId: string,
  argsHash: string,
  argsRedacted: unknown,
  nowMs: number,
): PendingApprovalFile {
  return {
    approvalId,
    serverName: req.serverName,
    toolName: req.toolName,
    toolClass: req.toolClass,
    argsRedacted,
    argsHash,
    sessionId: req.sessionId,
    requestedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + req.timeoutMs).toISOString(),
    ...(req.agentName !== undefined ? { agentName: req.agentName } : {}),
    ...(req.waitTimeoutMs !== undefined
      ? { waitExpiresAt: new Date(nowMs + req.waitTimeoutMs).toISOString() }
      : {}),
    ...(req.decisionRule !== undefined ? { decisionRule: req.decisionRule } : {}),
    ...(req.policyHash !== undefined ? { policyHash: req.policyHash } : {}),
    ...(req.grantsHash !== undefined ? { grantsHash: req.grantsHash } : {}),
  }
}

/** Past the request's own expiry, or past the agent's capped wait: an approval reaches nobody. */
function isPastDelivery(pending: PendingApprovalFile, nowMs: number): boolean {
  return isExpiredAt(deliveryEndsAt(pending), nowMs)
}
