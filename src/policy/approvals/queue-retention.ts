import { RESOLVED_FILE_RETENTION_MS } from '../constants.js'
import type { StateDatabase } from '../store-backend.js'
import type { ApprovalsDb } from './queue-db.js'
import { deleteOrphanHolds } from './queue-holds-db.js'

/**
 * Retention of the approvals queue: settled requests older than
 * `RESOLVED_FILE_RETENTION_MS`, and holds whose request is no longer pending
 * (review R9 — an older build resolved it without knowing the hold table).
 * Split out of `queue-db.ts`/`queue.ts` for the <400-line file rule (R10).
 */

/**
 * Max rows one `enqueue` deletes per kind. Bounds the cleanup cost per call so
 * it amortizes over many calls instead of one long delete.
 */
export const RETENTION_CLEANUP_BATCH = 200

/**
 * A bounded delete of the oldest settled requests. `resolved_at` holds a
 * fixed-width UTC ISO timestamp, so string comparison IS chronological
 * comparison and the cutoff needs no parsing. The inner SELECT keeps one call's
 * cost bounded, exactly as the file sweep it replaces was.
 */
const DELETE_OLD_RESOLVED =
  'DELETE FROM approvals WHERE approval_id IN (SELECT approval_id FROM approvals ' +
  "WHERE status = 'resolved' AND resolved_at < ? ORDER BY resolved_at LIMIT ?)"

/**
 * Deletes up to `limit` resolved rows settled before `cutoffIso` (an ISO-8601
 * UTC instant). Returns how many rows went, so a caller can tell "nothing was
 * old enough" from "the batch was full".
 */
export function deleteResolvedOlderThan(
  database: StateDatabase,
  cutoffIso: string,
  limit: number,
): number {
  return Number(database.prepare(DELETE_OLD_RESOLVED).run(cutoffIso, limit).changes)
}

/**
 * Best-effort retention, run after each enqueue: up to
 * `RETENTION_CLEANUP_BATCH` of the oldest long-settled records and as many
 * orphan holds, so neither grows without bound across a long-lived session.
 * ONE transaction attempt, bounded by the statement busy timeout — never the
 * busy-retry loop the queue's own writes use: a contended writer is somebody
 * else's decision landing, so this call simply skips the cleanup and a later
 * enqueue retries it. Never throws.
 */
export function pruneRetention(db: ApprovalsDb, nowMs: number): void {
  const cutoffIso = new Date(nowMs - RESOLVED_FILE_RETENTION_MS).toISOString()
  try {
    db.handle.transaction((database) => {
      deleteResolvedOlderThan(database, cutoffIso, RETENTION_CLEANUP_BATCH)
      deleteOrphanHolds(database, RETENTION_CLEANUP_BATCH)
    })
  } catch {
    // Locked, or gone: retention is opportunistic and never fails an enqueue.
  }
}
