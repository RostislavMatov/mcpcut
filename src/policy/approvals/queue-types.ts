import type { ToolClass } from '../schema.js'
import type { ResolveOutcome } from './queue-file.js'
import type { ResolveResult } from './queue-resolve.js'
import type {
  ApprovalResolution,
  PendingApproval,
  ResolvedApprovalFile,
} from './queue-file.js'

/**
 * The public contract of the approvals queue (`queue.ts`), split out purely
 * for the <400-line file rule — `queue.ts` re-exports everything here, so
 * importers see one module.
 */

export interface EnqueueRequest {
  readonly serverName: string
  readonly toolName: string
  readonly toolClass: ToolClass
  /** Raw (unredacted) call arguments. Redacted before ever touching storage. */
  readonly args: unknown
  readonly sessionId: string
  /** How long the request stays approvable: `expiresAt` = request time + this (M36: at most 24 h). */
  readonly timeoutMs: number
  /** Name of the authenticated agent behind the call; absent on the ad-hoc `wrap` path (M4). */
  readonly agentName?: string
  /** The policy's cap on the agent's wait, when it sets one; persisted as `waitExpiresAt` (M4). */
  readonly waitTimeoutMs?: number
  /** The policy rule that resolved to require-approval (M4). */
  readonly decisionRule?: string
  /** Fingerprint of the effective policy in force when the request was made (M5). */
  readonly policyHash?: string
  /** Fingerprint of the requesting agent's grant matrix at request time; absent without an agent (M5). */
  readonly grantsHash?: string
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
   *
   * SWEEPS FIRST (`queue-sweep.ts`): a request that outlived its `expiresAt`
   * settles as `expired` and leaves this list instead of lingering as a dead
   * card until its session ends. Nothing is lost — the record keeps the
   * outcome `markExpired()` writes, so `readResolution()`, `listResolved()`
   * and the journal's `timeout` decision record still say what happened.
   */
  list(opts?: BoundedReadOptions): Promise<PendingApproval[]>
  /**
   * How many requests are pending in total, regardless of any list bound.
   * Sweeps first, exactly as `list()` does, so the number an operator is shown
   * counts only requests a decision could still act on.
   */
  countPending(): Promise<number>
  resolve(approvalId: string, resolution: ResolveInput): Promise<ResolveResult>
  /**
   * Records an unresolved approval as `expired` — a capped wait that ran out
   * (`approval.timeoutMs`) and the lazy expiry sweep share this one write.
   */
  markExpired(approvalId: string): Promise<ResolveResult>
  /**
   * The agent stopped waiting (M36): records the request as `withdrawn` with
   * `reason` (already cleaned, see `withdraw.ts`). Races an operator's
   * `resolve()` through the same conditional write: exactly one wins.
   */
  withdraw(approvalId: string, reason: string): Promise<ResolveResult>
  /** Refreshes the heartbeat of a request the caller is still holding; a settled one is left alone. */
  heartbeat(approvalId: string): Promise<void>
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
