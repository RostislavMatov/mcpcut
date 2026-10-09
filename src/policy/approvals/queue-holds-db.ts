import type { StateDatabase } from '../store-backend.js'
import type { HoldRecord, HolderIdentity } from './holder.js'

/**
 * The hold of a pending request (decision M36, crash backstop): the process
 * holding a call refreshes the request's heartbeat here and names itself (pid
 * and host, review R3); a pending request whose heartbeat went stale AND whose
 * holder is provably gone belongs to a process that died without tearing
 * down, and the lazy sweep withdraws it (`queue-sweep.ts`, `holder.ts`).
 *
 * A SIDE TABLE rather than new columns of `approvals`, so the migration stays
 * what every other one in this database is — `CREATE … IF NOT EXISTS`, no
 * `ALTER`, no version table — and a row written by an older build (which has
 * no hold at all) stays readable and is simply never judged by it. A hold
 * lives exactly as long as its request is pending: inserted with the request,
 * deleted in the same transaction that resolves it; a hold an older build
 * left behind when IT resolved the request is pruned by retention (R9).
 *
 * Split out of `queue-db.ts` for the <400-line file rule; the connection,
 * pacing and transaction helpers stay there.
 */

const CREATE_HOLDS_TABLE =
  'CREATE TABLE IF NOT EXISTS approval_holds (' +
  'approval_id TEXT PRIMARY KEY, ' +
  'heartbeat_at TEXT NOT NULL, ' +
  'holder_pid INTEGER NOT NULL, ' +
  'holder_host TEXT NOT NULL, ' +
  'holder_nonce TEXT NOT NULL) STRICT'

/** A development shape of the hold table (no nonce): unreleased, transient rows, so it is replaced. */
const HOLDS_COLUMNS = "SELECT name FROM pragma_table_info('approval_holds')"
const DROP_HOLDS_TABLE = 'DROP TABLE IF EXISTS approval_holds'

/**
 * The heartbeat-only table of unreleased development builds of M36 phase A,
 * which named no holder. Nothing released ever wrote it, and its rows are
 * transient by nature, so it is dropped rather than migrated.
 */
const DROP_DEVELOPMENT_HEARTBEATS_TABLE = 'DROP TABLE IF EXISTS approval_heartbeats'

/** The stale-heartbeat sweep filters and sorts on `heartbeat_at`. */
const CREATE_HEARTBEAT_AT_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_approval_holds_heartbeat ON approval_holds(heartbeat_at)'

const INSERT_HOLD =
  'INSERT OR REPLACE INTO approval_holds (approval_id, heartbeat_at, holder_pid, holder_host, holder_nonce) ' +
  'VALUES (?, ?, ?, ?, ?)'

/**
 * Refreshes the heartbeats of a whole session's held requests in ONE statement
 * (review R2): the ids arrive as one JSON array. Only a still-pending request
 * is refreshed: a refresh racing the resolution must never recreate a row the
 * resolve just deleted.
 */
const REFRESH_HEARTBEATS =
  'UPDATE approval_holds SET heartbeat_at = ? WHERE approval_id IN (SELECT value FROM json_each(?)) AND EXISTS ' +
  "(SELECT 1 FROM approvals WHERE approvals.approval_id = approval_holds.approval_id AND status = 'pending')"

const DELETE_HOLD = 'DELETE FROM approval_holds WHERE approval_id = ?'

const SELECT_HOLD =
  'SELECT heartbeat_at, holder_pid, holder_host, holder_nonce FROM approval_holds WHERE approval_id = ?'

/**
 * Candidates for the stale-heartbeat sweep, stalest first. Exported so the
 * index test can `EXPLAIN QUERY PLAN` the exact statement, as for the expiry
 * sweep. ISO-8601 UTC timestamps of fixed width compare as strings.
 *
 * `CROSS JOIN` is SQLite's way of pinning the join order: the heartbeat range
 * drives (a seek on `idx_approval_holds_heartbeat` that also yields the
 * order), and each candidate is then looked up by primary key. Left to
 * itself, the planner of an unanalyzed database drives from every pending
 * request instead and sorts the result in a temp b-tree — the full pending
 * scan the sweep's bound exists to avoid.
 */
export const SELECT_STALE_HOLDS =
  'SELECT a.approval_id AS approval_id, a.doc AS doc, h.heartbeat_at AS heartbeat_at, ' +
  'h.holder_pid AS holder_pid, h.holder_host AS holder_host, h.holder_nonce AS holder_nonce ' +
  'FROM approval_holds h ' +
  'CROSS JOIN approvals a ON a.approval_id = h.approval_id ' +
  "WHERE h.heartbeat_at < ? AND a.status = 'pending' ORDER BY h.heartbeat_at LIMIT ?"

/**
 * Retention (review R9): holds whose request is no longer pending — an older
 * build resolved it without knowing this table — or is gone altogether.
 * Bounded, like the resolved-row retention beside it.
 */
const DELETE_ORPHAN_HOLDS =
  'DELETE FROM approval_holds WHERE approval_id IN (SELECT h.approval_id FROM approval_holds h ' +
  'LEFT JOIN approvals a ON a.approval_id = h.approval_id ' +
  "WHERE a.approval_id IS NULL OR a.status <> 'pending' LIMIT ?)"

/** Idempotent schema setup, run once per connection by `openApprovalsDb`. */
export function prepareHoldsSchema(database: StateDatabase): void {
  database.exec(DROP_DEVELOPMENT_HEARTBEATS_TABLE)
  const columns = database.prepare(HOLDS_COLUMNS).all().map((row) => (row as { name?: unknown }).name)
  if (columns.length > 0 && !columns.includes('holder_nonce')) database.exec(DROP_HOLDS_TABLE)
  database.exec(CREATE_HOLDS_TABLE)
  database.exec(CREATE_HEARTBEAT_AT_INDEX)
}

/** Starts (or restarts) the hold of `approvalId` at `atIso`, inside the caller's transaction. */
export function insertHold(
  database: StateDatabase,
  approvalId: string,
  atIso: string,
  holder: HolderIdentity,
): void {
  database.prepare(INSERT_HOLD).run(approvalId, atIso, holder.pid, holder.host, holder.nonce)
}

/** Moves the heartbeats of the still-pending requests among `approvalIds` to `atIso`; others are untouched. */
export function refreshHeartbeats(
  database: StateDatabase,
  approvalIds: readonly string[],
  atIso: string,
): void {
  database.prepare(REFRESH_HEARTBEATS).run(atIso, JSON.stringify(approvalIds))
}

/** Ends the hold of a request that is being resolved, inside the resolving transaction. */
export function deleteHold(database: StateDatabase, approvalId: string): void {
  database.prepare(DELETE_HOLD).run(approvalId)
}

/** The hold of one request, or `undefined` when it has none (resolved, or enqueued by an older build). */
export function selectHold(database: StateDatabase, approvalId: string): HoldRecord | undefined {
  return holdOf(database.prepare(SELECT_HOLD).get(approvalId))
}

/** A pending row the stale sweep may withdraw, by PRIMARY KEY, with the record it stores and its hold. */
export interface StaleHoldRow {
  readonly approvalId: string
  readonly doc: string
  readonly hold: HoldRecord
}

/** At most `limit` pending rows whose heartbeat is older than `cutoffIso`. Candidates only: the caller judges. */
export function selectStaleHoldRows(
  database: StateDatabase,
  cutoffIso: string,
  limit: number,
): StaleHoldRow[] {
  return database
    .prepare(SELECT_STALE_HOLDS)
    .all(cutoffIso, limit)
    .flatMap((row): StaleHoldRow[] => {
      if (typeof row !== 'object' || row === null) return []
      const { approval_id: approvalId, doc } = row as Record<string, unknown>
      const hold = holdOf(row)
      if (typeof approvalId !== 'string' || typeof doc !== 'string' || hold === undefined) return []
      return [{ approvalId, doc, hold }]
    })
}

/** Deletes up to `limit` holds whose request is no longer pending; returns how many went. */
export function deleteOrphanHolds(database: StateDatabase, limit: number): number {
  return Number(database.prepare(DELETE_ORPHAN_HOLDS).run(limit).changes)
}

/**
 * The hold columns of a row (`heartbeat_at`, `holder_pid`, `holder_host`,
 * `holder_nonce`), or `undefined` when any is missing or mistyped — a LEFT
 * JOIN that found no hold, or a foreign table of the same name.
 */
export function holdOf(row: unknown): HoldRecord | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const fields = row as Record<string, unknown>
  const { heartbeat_at: heartbeatAt, holder_pid: pid, holder_host: host, holder_nonce: nonce } = fields
  if (typeof heartbeatAt !== 'string' || typeof host !== 'string' || typeof nonce !== 'string') return undefined
  if (typeof pid !== 'number' && typeof pid !== 'bigint') return undefined
  return { heartbeatAt, holder: { pid: Number(pid), host, nonce } }
}
