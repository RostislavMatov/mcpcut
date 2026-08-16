import { join } from 'node:path'
import { ulid } from 'ulid'
import { APPROVALS_LIST_MAX_ROWS, JOURNAL_DIR } from '../../config.js'
import { redact } from '../../redact/redact.js'
import { canonicalJson, sha256Hex } from '../hash.js'
import type { ToolClass } from '../schema.js'
import {
  bumpChangeSeq,
  insertPendingRow,
  openApprovalsDb,
  resolvePendingRow,
  runWriteTransaction,
  countPendingRows,
  selectChangesSince,
  selectLatestChangeSeq,
  selectNewestResolvedDocs,
  selectPendingDoc,
  selectPendingDocs,
  selectResolvedDoc,
} from './queue-db.js'

/**
 * The approvals queue: one row per request in the `approvals` table of
 * `state.db` (wave 3 of M4.5; the shapes it stores are unchanged, see
 * `queue-file.ts`). Each record is kept whole as JSON text in the `doc`
 * column and re-validated on the way out, so a hand-written or foreign row is
 * skipped rather than trusted, exactly as an unparseable file was.
 *
 * `resolve()`'s correctness rests on the conditional `UPDATE … WHERE
 * status = 'pending'` inside `BEGIN IMMEDIATE` (see `queue-db.ts`): it is the
 * single serialization point that the file-based queue got from `rename()`,
 * so of two concurrent resolvers exactly one wins and the other reports
 * `not-found-or-already-resolved`.
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
import {
  isPendingApprovalFile,
  isResolvedApprovalFile,
  type ApprovalResolution,
  type PendingApproval,
  type PendingApprovalFile,
  type ResolutionOutcome,
  type ResolveOutcome,
  type ResolvedApprovalFile,
} from './queue-file.js'

/** Approval ids are ULIDs; validated before ever reaching a query parameter. */
const APPROVAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * "Expired" is `now >= expiresAt` — the expiry INSTANT is already expired —
 * on BOTH the list and the resolve path, so an operator can never see a
 * request as live that `resolve()` would downgrade (or vice versa). An
 * unparseable timestamp cannot reach here (`isPendingApprovalFile` rejects
 * it, review H2) but is treated as already expired anyway: fail closed twice.
 */
function isExpiredAt(expiresAt: string, nowMs: number): boolean {
  const expiresAtMs = Date.parse(expiresAt)
  return Number.isNaN(expiresAtMs) || nowMs >= expiresAtMs
}

export interface EnqueueRequest {
  readonly serverName: string
  readonly toolName: string
  readonly toolClass: ToolClass
  /** Raw (unredacted) call arguments. Redacted before ever touching storage. */
  readonly args: unknown
  readonly sessionId: string
  readonly timeoutMs: number
  /** Name of the authenticated agent behind the call; absent on the ad-hoc `wrap` path (M4). */
  readonly agentName?: string
  /** The agent's own wait window; persisted as `waitExpiresAt` when present (M4). */
  readonly waitTimeoutMs?: number
  /** The policy rule that resolved to require-approval (M4). */
  readonly decisionRule?: string
}

export interface EnqueueResult {
  readonly approvalId: string
  readonly argsHash: string
}

export interface ResolveInput {
  readonly outcome: ResolveOutcome
  readonly actor?: string
  readonly reason?: string
}

export type ResolveResult =
  | { readonly ok: true; readonly record: ResolvedApprovalFile }
  | { readonly ok: false; readonly reason: 'not-found-or-already-resolved' }

export interface ListResolvedOptions {
  /** How many of the newest resolved entries to return; only that many rows are read. */
  readonly limit: number
}

/**
 * What changed in the queue since a given sequence. `latestSeq` is the
 * watermark to pass to the NEXT call; a change can be reported twice (a write
 * that commits mid-read lands above the watermark), never skipped, so the
 * caller deduplicates by id — see `ui/watch.ts`.
 */
export interface ApprovalChanges {
  /**
   * The watermark to pass to the NEXT call. On a truncated page this is the
   * sequence of the last change actually DELIVERED, not the global latest —
   * reporting the global one would silently skip everything the page left
   * behind and break the "never skipped" contract.
   */
  readonly latestSeq: number
  /**
   * True when the read hit its row bound and more changes are already waiting.
   * A caller draining a backlog should poll again immediately rather than
   * waiting out its normal interval.
   */
  readonly truncated: boolean
  /** Requests still pending as of this read, with `expired` derived as in `list()`. */
  readonly newPending: readonly PendingApproval[]
  /** Ids of requests that have been resolved (by an operator, or as expired). */
  readonly resolvedIds: readonly string[]
}

/** Row bound for a queue read; omitted means the module default. */
export interface BoundedReadOptions {
  readonly limit?: number
}

export interface ApprovalQueue {
  enqueue(req: EnqueueRequest): Promise<EnqueueResult>
  /**
   * At most `limit` pending requests, OLDEST first (default
   * `APPROVALS_LIST_MAX_ROWS`). Bounded because an undrained queue otherwise
   * turned every UI poll into a full scan of the pending set; pair it with
   * `countPending()` to tell the operator what is not being shown.
   */
  list(opts?: BoundedReadOptions): Promise<PendingApproval[]>
  /** How many requests are pending in total, regardless of any list bound. */
  countPending(): Promise<number>
  resolve(approvalId: string, resolution: ResolveInput): Promise<ResolveResult>
  /** Records an unresolved approval as `expired`, for session teardown. */
  markExpired(approvalId: string): Promise<ResolveResult>
  /** `null` when the id is unknown or still pending. */
  readResolution(approvalId: string): Promise<ApprovalResolution | null>
  /**
   * The `limit` newest resolved approvals, newest first (M4 UI). Ids are
   * ULIDs, so lexicographic order IS chronological order: the query is
   * bounded to `limit` rows, never the whole table.
   */
  listResolved(opts: ListResolvedOptions): Promise<ResolvedApprovalFile[]>
  /**
   * The queue's delta feed, for a watcher that would otherwise re-read the
   * whole pending set every tick. `null` asks for a BASELINE: the current
   * watermark and no changes at all, so attaching to a live queue never
   * replays its backlog.
   */
  changesSince(sinceSeq: number | null, opts?: BoundedReadOptions): Promise<ApprovalChanges>
}

export interface ApprovalQueueOptions {
  /**
   * The queue directory, whose PARENT holds `state.db`. Defaults to
   * `JOURNAL_DIR/approvals`; a caller passing its own must keep it nested
   * (`join(someDir, 'approvals')`), never a bare directory.
   */
  readonly baseDir?: string
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  readonly clock?: () => number
}

/**
 * True when `approvalId` has the safe shape the queue accepts. Exported so
 * callers can reject a malformed id at their own boundary (the UI action
 * handler does) instead of only learning about it as a failed resolve.
 */
export function isValidApprovalId(approvalId: string): boolean {
  return APPROVAL_ID_PATTERN.test(approvalId)
}

/** Parses one stored record, returning `null` for anything the validators reject. */
function parseDoc<T>(text: string, isShape: (raw: unknown) => raw is T): T | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null // malformed JSON: skip, never throw on garbage content
  }
  return isShape(raw) ? raw : null // malformed shape: skip
}

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

  async function enqueue(req: EnqueueRequest): Promise<EnqueueResult> {
    const approvalId = ulid()
    const argsForHashing = req.args ?? null
    const argsHash = sha256Hex(canonicalJson(argsForHashing))
    const nowMs = clock()

    // Built (and redacted) outside the transaction: the writer lock is held
    // for the insert alone.
    const record: PendingApprovalFile = {
      approvalId,
      serverName: req.serverName,
      toolName: req.toolName,
      toolClass: req.toolClass,
      argsRedacted: redact(argsForHashing),
      argsHash,
      sessionId: req.sessionId,
      requestedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + req.timeoutMs).toISOString(),
      ...(req.agentName !== undefined ? { agentName: req.agentName } : {}),
      ...(req.waitTimeoutMs !== undefined
        ? { waitExpiresAt: new Date(nowMs + req.waitTimeoutMs).toISOString() }
        : {}),
      ...(req.decisionRule !== undefined ? { decisionRule: req.decisionRule } : {}),
    }
    const doc = JSON.stringify(record)

    const db = await openApprovalsDb(baseDir)
    await runWriteTransaction(db, (database) => {
      insertPendingRow(database, {
        approvalId,
        doc,
        serverName: record.serverName,
        toolName: record.toolName,
        argsHash: record.argsHash,
        requestedAt: record.requestedAt,
        expiresAt: record.expiresAt,
        changeSeq: bumpChangeSeq(database),
      })
    })
    return { approvalId, argsHash }
  }

  async function list(listOpts: BoundedReadOptions = {}): Promise<PendingApproval[]> {
    const db = await openApprovalsDb(baseDir)
    const nowMs = clock()
    // Ordered by the query (oldest request first); `expired` is derived here
    // rather than stored, so it can never go stale in storage.
    return selectPendingDocs(db.handle.db, boundedLimit(listOpts.limit))
      .map((text) => parseDoc(text, isPendingApprovalFile))
      .filter((record): record is PendingApprovalFile => record !== null)
      .map((record) => ({ ...record, expired: isExpiredAt(record.expiresAt, nowMs) }))
  }

  /**
   * Resolves a pending request in one transaction: the pending record is read
   * and the conditional `UPDATE … WHERE status = 'pending'` written under the
   * same `BEGIN IMMEDIATE`, so two concurrent resolvers of one id cannot both
   * observe it as pending. The loser — and any caller of an unknown, already
   * resolved, or malformed id — gets `not-found-or-already-resolved`.
   */
  async function moveToResolved(
    approvalId: string,
    buildResolution: (pending: PendingApprovalFile) => Omit<ApprovalResolution, 'resolvedAt'>,
  ): Promise<ResolveResult> {
    if (!isValidApprovalId(approvalId)) {
      return { ok: false, reason: 'not-found-or-already-resolved' }
    }
    const db = await openApprovalsDb(baseDir)

    return runWriteTransaction(db, (database): ResolveResult => {
      // The clock is read INSIDE the transaction, once the writer lock is
      // held: `resolvedAt` (and the expiry downgrade built from the same
      // moment) then describe when the resolution actually lands, so a
      // resolve that waited out a contended lock can never persist an
      // `approved` whose request expired during the wait.
      const resolvedAt = new Date(clock()).toISOString()
      const text = selectPendingDoc(database, approvalId)
      const pending = text === null ? null : parseDoc(text, isPendingApprovalFile)
      // A malformed pending record is as unresolvable as a missing one: it
      // must never be listed, approved, or downgraded.
      if (pending === null) return { ok: false, reason: 'not-found-or-already-resolved' }

      const record: ResolvedApprovalFile = {
        ...pending,
        resolution: buildResolution(pending),
        resolvedAt,
      }
      const won = resolvePendingRow(database, {
        approvalId,
        doc: JSON.stringify(record),
        outcome: record.resolution.outcome,
        resolvedAt,
        changeSeq: bumpChangeSeq(database),
      })
      // Unreachable while the row is read and written under one write lock;
      // kept as the defence in depth that owns the "one winner" invariant.
      if (!won) return { ok: false, reason: 'not-found-or-already-resolved' }
      return { ok: true, record }
    })
  }

  /**
   * Records an operator resolution. Time-aware for `approved`: if the request
   * has already passed its `expiresAt`, the session it was for is dead and a
   * late `approved` would let `checkRecentApproval` mint a grant for a
   * finished session. Such a stale approval is DOWNGRADED to `expired` (the
   * operator's `actor`/`reason` are preserved for the audit trail) so no
   * `approved` resolution is ever persisted past expiry. A `denied` on a stale
   * request is harmless and is recorded as-is.
   */
  function resolve(approvalId: string, resolution: ResolveInput): Promise<ResolveResult> {
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
    const rows = selectChangesSince(database, sinceSeq, limit + 1)
    const truncated = rows.length > limit
    const delivered = truncated ? rows.slice(0, limit) : rows

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
    // the global one would skip the remainder outright.
    const lastDelivered = delivered.at(-1)
    return {
      latestSeq: truncated && lastDelivered !== undefined ? lastDelivered.changeSeq : latestSeq,
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
    readResolution,
    listResolved,
    changesSince,
  }
}
