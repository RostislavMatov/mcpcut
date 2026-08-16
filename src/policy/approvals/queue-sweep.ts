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
 * 2. THROUGH `markExpired`, not around it. A swept row is written by the same
 *    conditional `UPDATE … WHERE status = 'pending'` inside `BEGIN IMMEDIATE`
 *    that teardown uses, so the result is indistinguishable from a torn-down
 *    request and the one-outcome-per-id invariant is the one already audited:
 *    of two concurrent sweepers exactly one wins, and neither can overwrite a
 *    human decision that landed first.
 * 3. BEST-EFFORT. A row this call cannot expire stays pending — precisely the
 *    state it was in before the call — and the next read retries it. An
 *    opportunistic maintenance write must never turn an operator's read into
 *    an error; that is the whole point of expiring these rows in the first
 *    place.
 */

/** What one sweep pass needs; `markExpired` is the queue's own, injected to keep this module free of its closure. */
export interface SweepExpiredDeps {
  /** The queue directory (`<journalDir>/approvals`), as `createApprovalQueue` resolved it. */
  readonly baseDir: string
  /** The instant the calling read is judging the queue at — its own clock, once. */
  readonly nowMs: number
  /** `ApprovalQueue.markExpired`, narrowed to what the sweep observes. */
  readonly markExpired: (approvalId: string) => Promise<{ readonly ok: boolean }>
}

/**
 * One bounded pass: the same row budget a single read of the pending set gets
 * (`APPROVALS_LIST_MAX_ROWS`). A backlog larger than that is expired across
 * several reads instead of holding the writer for an unbounded batch — and
 * whatever this pass did not reach is still reported as `expired` by `list()`,
 * which derives that flag per row rather than trusting storage.
 */
const SWEEP_MAX_ROWS = APPROVALS_LIST_MAX_ROWS

/**
 * Expires every pending request whose own `expiresAt` has passed, one
 * transaction per row. Returns how many rows this pass actually settled — 0
 * being the overwhelmingly common case, in which the sweep is a single indexed
 * SELECT and takes no writer lock at all.
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

  let swept = 0
  for (const approvalId of candidates) {
    try {
      const result = await deps.markExpired(approvalId)
      // `ok: false` is the expected loser of a race — another sweeper, an
      // operator resolving in the same instant, or teardown. The row has an
      // outcome either way, which is all this pass wanted.
      if (result.ok) swept += 1
    } catch {
      // A contended writer or a storage failure leaves the row pending; the
      // next `list()`/`countPending()` sweeps it again.
    }
  }
  return swept
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
