import type { StateDatabase } from '../store-backend.js'

/**
 * The heartbeat of a held request (decision M36, crash backstop): the gate
 * holding a call refreshes its row here; a pending request whose heartbeat has
 * gone stale belongs to a process that died without tearing down, and the lazy
 * sweep withdraws it (`queue-sweep.ts`).
 *
 * A SIDE TABLE rather than a new column of `approvals`, so the migration stays
 * what every other one in this database is — `CREATE … IF NOT EXISTS`, no
 * `ALTER`, no version table — and a row written by an older build (which has
 * no heartbeat at all) stays readable and is simply never judged by it. A
 * heartbeat lives exactly as long as its request is pending: inserted with the
 * request, deleted in the same transaction that resolves it.
 *
 * Split out of `queue-db.ts` for the <400-line file rule; the connection,
 * pacing and transaction helpers stay there.
 */

const CREATE_HEARTBEATS_TABLE =
  'CREATE TABLE IF NOT EXISTS approval_heartbeats (' +
  'approval_id TEXT PRIMARY KEY, ' +
  'heartbeat_at TEXT NOT NULL) STRICT'

/** The stale-heartbeat sweep filters and sorts on `heartbeat_at`. */
const CREATE_HEARTBEAT_AT_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_approval_heartbeats_at ON approval_heartbeats(heartbeat_at)'

const INSERT_HEARTBEAT = 'INSERT OR REPLACE INTO approval_heartbeats (approval_id, heartbeat_at) VALUES (?, ?)'

/**
 * Refreshes a heartbeat only while its request is still pending: a refresh
 * racing the resolution must never recreate a row the resolve just deleted.
 */
const REFRESH_HEARTBEAT =
  'UPDATE approval_heartbeats SET heartbeat_at = ? WHERE approval_id = ? AND EXISTS ' +
  "(SELECT 1 FROM approvals WHERE approvals.approval_id = approval_heartbeats.approval_id AND status = 'pending')"

const DELETE_HEARTBEAT = 'DELETE FROM approval_heartbeats WHERE approval_id = ?'

/**
 * Candidates for the stale-heartbeat sweep, stalest first. Exported so the
 * index test can `EXPLAIN QUERY PLAN` the exact statement, as for the expiry
 * sweep. ISO-8601 UTC timestamps of fixed width compare as strings.
 *
 * `CROSS JOIN` is SQLite's way of pinning the join order: the heartbeat range
 * drives (a seek on `idx_approval_heartbeats_at` that also yields the order),
 * and each candidate is then looked up by primary key. Left to itself, the
 * planner of an unanalyzed database drives from every pending request instead
 * and sorts the result in a temp b-tree — the full pending scan the sweep's
 * bound exists to avoid.
 */
export const SELECT_STALE_HEARTBEATS =
  'SELECT a.approval_id AS approval_id, a.doc AS doc FROM approval_heartbeats h ' +
  'CROSS JOIN approvals a ON a.approval_id = h.approval_id ' +
  "WHERE h.heartbeat_at < ? AND a.status = 'pending' ORDER BY h.heartbeat_at LIMIT ?"

const SELECT_HEARTBEAT = 'SELECT heartbeat_at FROM approval_heartbeats WHERE approval_id = ?'

/** Idempotent schema setup, run once per connection by `openApprovalsDb`. */
export function prepareHeartbeatSchema(database: StateDatabase): void {
  database.exec(CREATE_HEARTBEATS_TABLE)
  database.exec(CREATE_HEARTBEAT_AT_INDEX)
}

/** Starts (or restarts) the heartbeat of `approvalId` at `atIso`, inside the caller's transaction. */
export function insertHeartbeat(database: StateDatabase, approvalId: string, atIso: string): void {
  database.prepare(INSERT_HEARTBEAT).run(approvalId, atIso)
}

/** Moves the heartbeat of a still-pending request to `atIso`; a resolved or unknown id changes nothing. */
export function refreshHeartbeat(database: StateDatabase, approvalId: string, atIso: string): void {
  database.prepare(REFRESH_HEARTBEAT).run(atIso, approvalId)
}

/** Ends the heartbeat of a request that is being resolved, inside the resolving transaction. */
export function deleteHeartbeat(database: StateDatabase, approvalId: string): void {
  database.prepare(DELETE_HEARTBEAT).run(approvalId)
}

/** The heartbeat of one request, or `undefined` when it has none (resolved, or enqueued by an older build). */
export function selectHeartbeat(database: StateDatabase, approvalId: string): string | undefined {
  const row = database.prepare(SELECT_HEARTBEAT).get(approvalId)
  if (typeof row !== 'object' || row === null) return undefined
  const value = (row as { heartbeat_at?: unknown }).heartbeat_at
  return typeof value === 'string' ? value : undefined
}

/** A pending row the stale sweep may withdraw, by PRIMARY KEY, with the record it stores. */
export interface StaleHeartbeatRow {
  readonly approvalId: string
  readonly doc: string
}

/** At most `limit` pending rows whose heartbeat is older than `cutoffIso`. Candidates only: the caller re-checks. */
export function selectStaleHeartbeatRows(
  database: StateDatabase,
  cutoffIso: string,
  limit: number,
): StaleHeartbeatRow[] {
  return database
    .prepare(SELECT_STALE_HEARTBEATS)
    .all(cutoffIso, limit)
    .flatMap((row): StaleHeartbeatRow[] => {
      if (typeof row !== 'object' || row === null) return []
      const { approval_id: approvalId, doc } = row as Record<string, unknown>
      return typeof approvalId === 'string' && typeof doc === 'string' ? [{ approvalId, doc }] : []
    })
}
