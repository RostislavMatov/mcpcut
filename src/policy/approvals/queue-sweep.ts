import { APPROVALS_LIST_MAX_ROWS } from '../../config.js'
import { openApprovalsDb, selectExpiredPendingRows } from './queue-db.js'
import { isExpiredAt, isPendingApprovalFile, parseDoc } from './queue-file.js'

/**
 * The lazy expiry sweep of the approvals queue.
 *
 * Until this existed, expiry depended on SESSION LIFETIME: a request no human
 * resolved left `pending` only when `cancelPending()` (`proxy/gate-core.ts`)
 * marked it expired at teardown. A `wrap`/`connect` session in dogfood and
 * pilot shape lives for hours, so abandoned requests accumulated for as long as
 * the process ran, and `countPending()` — which feeds the UI badge and the
 * "N of M pending" line — counted requests that could never yield a grant.
 *
 * Three properties decide the shape here:
 *
 * 1. LAZY, not timed. The sweep runs on the reads whose truthfulness is at
 *    stake (`list()`, `countPending()`), so there is no timer to own, no
 *    lifecycle to tear down, and nothing to leak in a short-lived CLI process.
 * 2. THROUGH the queue's own resolve write, not around it. A swept row is
 *    written by the same conditional `UPDATE … WHERE status = 'pending'`
 *    inside `BEGIN IMMEDIATE` that teardown uses, so the result is
 *    indistinguishable from a torn-down request and the one-outcome-per-id
 *    invariant is the one already audited: of two concurrent sweepers exactly
 *    one wins, and neither can overwrite a human decision that landed first.
 * 3. ONE TRANSACTION PER PASS, not per row. Because the sweep sits on the
 *    RENDER path — `list()` and `countPending()`, i.e. twice per approvals
 *    page and once per JSON poll — a transaction per expired row put N serial
 *    `BEGIN IMMEDIATE`/COMMIT pairs, each with its own busy-retry pacing, in
 *    front of the first byte an operator returning to an abandoned queue sees.
 *    The bound (`SWEEP_MAX_ROWS`) is what keeps the single transaction from
 *    being an unbounded one; the per-row write inside it is unchanged, so
 *    `change_seq` still moves exactly once per row actually settled — the
 *    contract `ui/watch.ts` publishes `approval-resolved` off.
 * 4. BEST-EFFORT. A row this call cannot expire stays pending — precisely the
 *    state it was in before the call — and the next read retries it. An
 *    opportunistic maintenance write must never turn an operator's read into
 *    an error; that is the whole point of expiring these rows in the first
 *    place.
 */

/** What one sweep pass needs; the write is the queue's own, injected to keep this module free of its closure. */
export interface SweepExpiredDeps {
  /** The queue directory (`<journalDir>/approvals`), as `createApprovalQueue` resolved it. */
  readonly baseDir: string
  /** The instant the calling read is judging the queue at — its own clock, once. */
  readonly nowMs: number
  /**
   * The queue's `markExpiredBatch`: expires a bounded batch of already
   * identified pending ids in ONE write transaction and answers how many rows
   * it actually settled. Rows another resolver won in the meantime keep their
   * decision and are not counted.
   */
  readonly markExpiredBatch: (approvalIds: readonly string[]) => Promise<number>
}

/**
 * One bounded pass: the same row budget a single read of the pending set gets
 * (`APPROVALS_LIST_MAX_ROWS`). Since the pass is now ONE transaction, this
 * bound is also the ceiling on how long that transaction holds the writer
 * lock — a backlog larger than it is expired across several reads rather than
 * in one unbounded batch, and whatever this pass did not reach is still
 * reported as `expired` by `list()`, which derives that flag per row rather
 * than trusting storage.
 */
const SWEEP_MAX_ROWS = APPROVALS_LIST_MAX_ROWS

/**
 * Expires every pending request whose own `expiresAt` has passed, in a single
 * bounded write transaction. Returns how many rows this pass actually settled
 * — 0 being the overwhelmingly common case, in which the sweep is a single
 * indexed SELECT (`idx_approvals_status_expires`) and takes no writer lock at
 * all: with nothing to expire, the render path pays one read.
 */
export async function sweepExpiredPending(deps: SweepExpiredDeps): Promise<number> {
  let candidates: readonly string[]
  try {
    candidates = await expiredPendingIds(deps.baseDir, deps.nowMs)
  } catch {
    // Nothing to hide here: the caller opens the same database one line later
    // and reports the classified storage failure itself.
    return 0
  }
  if (candidates.length === 0) return 0

  try {
    return await deps.markExpiredBatch(candidates)
  } catch {
    // A contended writer past its budget, or a storage failure: every row of
    // the batch stays pending — exactly the state it was already in — and the
    // next `list()`/`countPending()` sweeps it again. The read never sees this.
    return 0
  }
}

/**
 * The ids of pending rows that are expired BY THEIR RECORD. The column
 * narrows, the record decides (`isExpiredAt`, shared with the list and resolve
 * paths), and the PRIMARY KEY — never `doc.approvalId`, which a hand-written
 * row can point at some other request — is what the write targets.
 */
async function expiredPendingIds(baseDir: string, nowMs: number): Promise<string[]> {
  const db = await openApprovalsDb(baseDir)
  const rows = selectExpiredPendingRows(db.handle.db, new Date(nowMs).toISOString(), SWEEP_MAX_ROWS)
  return rows
    .filter((row) => {
      // A record that does not parse is unresolvable, not expired: `list()`
      // already hides it and `markExpired()` would refuse it, so inventing an
      // outcome for it here would be the one write nobody could justify.
      const record = parseDoc(row.doc, isPendingApprovalFile)
      return record !== null && isExpiredAt(record.expiresAt, nowMs)
    })
    .map((row) => row.approvalId)
}
