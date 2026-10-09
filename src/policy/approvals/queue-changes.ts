import type { StateDatabase } from '../store-backend.js'
import { isExpiredAt, isPendingApprovalFile, parseDoc, type PendingApproval } from './queue-file.js'
import type { ApprovalChanges } from './queue-types.js'

/**
 * The approvals queue's delta feed (`ApprovalQueue.changesSince`): its SQL and
 * the paging rules, together. Split out of `queue-db.ts` and `queue.ts` for
 * the <400-line file rule (review R10); a watcher (`ui/watch.ts`) reads it
 * instead of re-reading the whole pending set every tick.
 */

const SELECT_LATEST_SEQ = 'SELECT change_seq FROM approvals_meta WHERE id = 1'

/** Every row touched after `?`, oldest change first, so a reader can replay in order. */
const SELECT_CHANGES_SINCE =
  'SELECT approval_id, status, doc, change_seq FROM approvals WHERE change_seq > ? ' +
  'ORDER BY change_seq LIMIT ?'

/** One changed row as a change reader sees it; `doc` still carries the whole record. */
interface ApprovalChangeRow {
  readonly approvalId: string
  readonly status: string
  readonly doc: string
  /** This row's change sequence — the watermark a truncated page stops at. */
  readonly changeSeq: number
}

/** One page of the change feed: the usable rows plus how many SQL actually returned. */
interface ChangePage {
  readonly rows: readonly ApprovalChangeRow[]
  readonly fetched: number
}

/**
 * The counter as it stands, which is the watermark a change reader carries
 * between polls. It is read from the meta row rather than from `MAX(change_seq)`
 * so retention deleting the newest resolved row can never rewind the watermark
 * and replay the whole table.
 */
function selectLatestChangeSeq(database: StateDatabase): number {
  const row = database.prepare(SELECT_LATEST_SEQ).get() as { change_seq?: unknown } | undefined
  const latest = row?.change_seq
  return typeof latest === 'number' && Number.isInteger(latest) ? latest : 0
}

/**
 * Every row whose change sequence is past `sinceSeq`. Callers MUST read the
 * watermark (`selectLatestChangeSeq`) BEFORE this query: a write committing
 * between the two then shows up in this result while staying above the reported
 * watermark, so it is delivered again on the next poll — at-least-once, which a
 * caller can deduplicate. The other order would drop it silently.
 */
function selectChangesSince(database: StateDatabase, sinceSeq: number, limit: number): ChangePage {
  const rows = database.prepare(SELECT_CHANGES_SINCE).all(sinceSeq, limit)
  return {
    // `fetched` counts what SQL returned, BEFORE malformed rows are dropped.
    // The caller decides truncation by comparing it to the limit, and a dropped
    // row must not make a full page look like a partial one.
    fetched: rows.length,
    rows: rows.map(changeRow).filter((row): row is ApprovalChangeRow => row !== null),
  }
}

function changeRow(row: unknown): ApprovalChangeRow | null {
  if (typeof row !== 'object' || row === null) return null
  const { approval_id: approvalId, status, doc, change_seq: changeSeq } = row as Record<string, unknown>
  if (typeof approvalId !== 'string' || typeof status !== 'string') return null
  if (typeof changeSeq !== 'number' && typeof changeSeq !== 'bigint') return null
  // A malformed `doc` is kept as an empty string rather than dropping the row:
  // the id and status are still the truth about WHAT changed, and the record
  // parser above this layer skips the unusable content (MALFORMED_SKIP).
  return {
    approvalId,
    status,
    doc: typeof doc === 'string' ? doc : '',
    changeSeq: Number(changeSeq),
  }
}

/** See `ApprovalQueue.changesSince`; `limit` is already bounded by the caller. */
export function readChangesSince(
  database: StateDatabase,
  sinceSeq: number | null,
  limit: number,
  nowMs: number,
): ApprovalChanges {
  // Watermark first, rows second: see `selectChangesSince` — this order can
  // only ever re-deliver a change, never lose one.
  const latestSeq = selectLatestChangeSeq(database)
  if (sinceSeq === null) return { latestSeq, truncated: false, newPending: [], resolvedIds: [] }

  // One row over the bound, so "is there more" is answered by the same read
  // rather than by a second query against a moving table.
  const page = selectChangesSince(database, sinceSeq, limit + 1)
  // Truncation is decided by what SQL returned, not by what survived parsing:
  // a malformed row dropped on the way would otherwise make a full page look
  // partial and stall the drain one page short.
  const truncated = page.fetched > limit
  const delivered = truncated ? page.rows.slice(0, limit) : page.rows

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
