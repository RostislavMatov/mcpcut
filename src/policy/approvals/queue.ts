import { join } from 'node:path'
import { ulid } from 'ulid'
import { APPROVALS_LIST_MAX_ROWS, JOURNAL_DIR } from '../../config.js'
import { redact } from '../../redact/redact.js'
import { APPROVAL_HEARTBEAT_STALE_MS, RESOLVED_FILE_RETENTION_MS } from '../constants.js'
import { canonicalJson, sha256Hex } from '../hash.js'
import {
  bumpChangeSeq,
  deleteResolvedOlderThan,
  insertPendingRow,
  openApprovalsDb,
  runWriteTransaction,
  countPendingRows,
  selectChangesSince,
  selectLatestChangeSeq,
  selectNewestResolvedDocs,
  selectPendingDocs,
  selectResolvedDoc,
  type ApprovalsDb,
} from './queue-db.js'
import { insertHeartbeat, refreshHeartbeat } from './queue-heartbeat-db.js'
import { createQueueResolver, isValidApprovalId, type ResolveResult } from './queue-resolve.js'

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

/**
 * Max resolved rows one `enqueue` deletes for retention. Bounds the cleanup
 * cost per call so it amortizes over many calls instead of one long delete.
 */
const RETENTION_CLEANUP_BATCH = 200

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
  const { moveToResolvedBatch, moveToResolved } = createQueueResolver(baseDir, clock)

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
      // The request is held from this instant (M36): its heartbeat starts with it.
      insertHeartbeat(database, approvalId, record.requestedAt)
    })
    pruneOldResolvedRows(db, nowMs)
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
      if (row.heartbeatAt === undefined) return [{ ...record, expired }]
      return [{ ...record, expired, agentConnected: isFreshHeartbeat(row.heartbeatAt, nowMs) }]
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

  /** The heartbeat sweep's write: requests whose holder died, withdrawn as `process-lost`. */
  async function withdrawLostBatch(approvalIds: readonly string[]): Promise<number> {
    const results = await moveToResolvedBatch(approvalIds, () => ({
      outcome: 'withdrawn',
      reason: WITHDRAW_REASON_PROCESS_LOST,
    }))
    return results.filter((result) => result.ok).length
  }

  /**
   * Records an operator resolution. Time-aware for `approved`: a request past
   * its `expiresAt` (the 24-hour cap, or the policy's shorter wait) can no
   * longer reach anybody, so a late `approved` is DOWNGRADED to `expired` (the
   * operator's `actor`/`reason` are preserved for the audit trail) and no
   * `approved` resolution is ever persisted past expiry. A `denied` on a stale
   * request is harmless and is recorded as-is.
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
    return moveToResolved(approvalId, (pending) => {
      const expired = isExpiredAt(pending.expiresAt, clock())
      const outcome: ResolutionOutcome =
        expired && resolution.outcome === 'approved' ? 'expired' : resolution.outcome
      return {
        outcome,
        ...(resolution.actor !== undefined ? { actor: resolution.actor } : {}),
        ...(resolution.reason !== undefined ? { reason: resolution.reason } : {}),
      }
    })
  }

  function markExpired(approvalId: string): Promise<ResolveResult> {
    return moveToResolved(approvalId, () => ({ outcome: 'expired' }))
  }

  function withdraw(approvalId: string, reason: string): Promise<ResolveResult> {
    return moveToResolved(approvalId, () => ({ outcome: 'withdrawn', reason }))
  }

  async function heartbeat(approvalId: string): Promise<void> {
    if (!isValidApprovalId(approvalId)) return
    const db = await openApprovalsDb(baseDir)
    const atIso = new Date(clock()).toISOString()
    await runWriteTransaction(db, (database) => refreshHeartbeat(database, approvalId, atIso))
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

  /** See `ApprovalQueue.changesSince`. */
  async function changesSince(
    sinceSeq: number | null,
    changeOpts: BoundedReadOptions = {},
  ): Promise<ApprovalChanges> {
    const db = await openApprovalsDb(baseDir)
    const database = db.handle.db
    // Watermark first, rows second: see `selectChangesSince` — this order can
    // only ever re-deliver a change, never lose one.
    const latestSeq = selectLatestChangeSeq(database)
    if (sinceSeq === null) return { latestSeq, truncated: false, newPending: [], resolvedIds: [] }

    // One row over the bound, so "is there more" is answered by the same read
    // rather than by a second query against a moving table.
    const limit = boundedLimit(changeOpts.limit)
    const page = selectChangesSince(database, sinceSeq, limit + 1)
    // Truncation is decided by what SQL returned, not by what survived parsing:
    // a malformed row dropped on the way would otherwise make a full page look
    // partial and stall the drain one page short.
    const truncated = page.fetched > limit
    const delivered = truncated ? page.rows.slice(0, limit) : page.rows

    const nowMs = clock()
    const newPending: PendingApproval[] = []
    const resolvedIds: string[] = []
    for (const row of delivered) {
      if (row.status === 'resolved') {
        resolvedIds.push(row.approvalId)
        continue
      }
      const record = parseDoc(row.doc, isPendingApprovalFile)
      if (record === null) continue // malformed content: skip, as `list()` does
      newPending.push({ ...record, expired: isExpiredAt(record.expiresAt, nowMs) })
    }
    // A truncated page stops the watermark at the last change it delivered —
    // the global one would skip the remainder outright. When the page hit its
    // bound but every row was dropped as malformed there is no last delivered
    // change, and the fallback is `sinceSeq`, NOT the global sequence: the
    // caller re-asks from where it was, which re-delivers (allowed) instead of
    // skipping every change between this page and the head (forbidden).
    const lastDelivered = delivered.at(-1)
    return {
      latestSeq: truncated ? (lastDelivered?.changeSeq ?? sinceSeq) : latestSeq,
      truncated,
      newPending,
      resolvedIds,
    }
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

/** A heartbeat younger than the stale limit; the limit itself is still live (the sweep takes only older ones). */
function isFreshHeartbeat(heartbeatAt: string, nowMs: number): boolean {
  const atMs = Date.parse(heartbeatAt)
  return !Number.isNaN(atMs) && nowMs - atMs <= APPROVAL_HEARTBEAT_STALE_MS
}

/**
 * Best-effort retention: deletes up to `RETENTION_CLEANUP_BATCH` of the oldest
 * records settled longer than `RESOLVED_FILE_RETENTION_MS` ago, so resolved
 * history cannot grow without bound across a long-lived session. ONE
 * transaction attempt, bounded by the statement busy timeout — never the
 * busy-retry loop the queue's own writes use: a contended writer is somebody
 * else's decision landing, so this call simply skips the cleanup and a later
 * enqueue retries it. Never throws.
 */
function pruneOldResolvedRows(db: ApprovalsDb, nowMs: number): void {
  const cutoffIso = new Date(nowMs - RESOLVED_FILE_RETENTION_MS).toISOString()
  try {
    db.handle.transaction((database) => deleteResolvedOlderThan(database, cutoffIso, RETENTION_CLEANUP_BATCH))
  } catch {
    // Locked, or gone: retention is opportunistic and never fails an enqueue.
  }
}
