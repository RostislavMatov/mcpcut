import { setTimeout as sleep } from 'node:timers/promises'
import { isSqliteBusy, type SqliteHandle } from '../../store/sqlite.js'
import {
  dbPathFor,
  openStateDbShared,
  rethrowClassified,
  type StateDatabase,
} from '../store-backend.js'
// Deliberate cycle with `queue-import.ts`: it needs this module's transaction
// helpers, this module needs its first-touch import. Both sides only ever call
// the other's (hoisted) functions, never read a binding while loading.
import { importLegacyApprovals } from './queue-import.js'

/**
 * The storage substrate of the approvals queue: schema, statements and write
 * pacing. Every piece of SQL the queue runs lives here, so `queue.ts` and
 * `grants.ts` stay pure record logic and `node:sqlite` keeps exactly one entry
 * point in the process (`src/store/sqlite.ts`, ADR-0006).
 *
 * The tables live in the SAME `state.db` as the document stores — the seam
 * wave 2 left open (`store-backend.ts`: "wave 3 adds its own tables to the
 * same database the same way") and what ADR-0006 fixed at two databases, not
 * three. The path is derived from the queue's `baseDir` PARENT, because
 * `baseDir` is by contract the `approvals/` subdirectory of a journal
 * directory (`join(journalDir, 'approvals')` at every production call site).
 */

/** One physical table with a `status` column, not two: resolving is then a
 * conditional UPDATE inside `BEGIN IMMEDIATE` — the exact replacement for the
 * `rename()` serialization point the file-based queue relied on, with the same
 * "exactly one resolver wins" guarantee. `doc` holds the whole record as JSON
 * text (the shapes in `queue-file.ts`, unchanged); the flat columns beside it
 * are denormalized copies that exist only to be indexed. STRICT keeps "the row
 * is JSON text plus scalars" enforced rather than conventional. */
const CREATE_APPROVALS_TABLE =
  'CREATE TABLE IF NOT EXISTS approvals (' +
  'approval_id TEXT PRIMARY KEY, ' +
  "status TEXT NOT NULL CHECK (status IN ('pending','resolved')), " +
  'doc TEXT NOT NULL, ' +
  'server_name TEXT NOT NULL, ' +
  'tool_name TEXT NOT NULL, ' +
  'args_hash TEXT NOT NULL, ' +
  'requested_at TEXT NOT NULL, ' +
  'expires_at TEXT NOT NULL, ' +
  'outcome TEXT, ' +
  'resolved_at TEXT, ' +
  'change_seq INTEGER NOT NULL) STRICT'

/** The pending-queue poll (`list()`) and the "what changed since seq" watcher. */
const CREATE_STATUS_SEQ_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_approvals_status_seq ON approvals(status, change_seq)'
const CREATE_SEQ_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_approvals_change_seq ON approvals(change_seq)'
/** The grant lookup on the gate's hot path (`checkRecentApproval`). */
const CREATE_GRANT_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_approvals_grant ON approvals(server_name, tool_name, args_hash)'

/**
 * A single-row counter, bumped in the same transaction as the insert/resolve
 * it stamps. It is what makes "what changed since I last looked" one indexed
 * query instead of a directory diff; `rowid`-style autoincrement would not do,
 * because a resolve must move an EXISTING row to the head of the sequence.
 */
const CREATE_APPROVALS_META_TABLE =
  'CREATE TABLE IF NOT EXISTS approvals_meta ' +
  '(id INTEGER PRIMARY KEY CHECK (id = 1), change_seq INTEGER NOT NULL) STRICT'
const SEED_APPROVALS_META = 'INSERT OR IGNORE INTO approvals_meta (id, change_seq) VALUES (1, 0)'

const BUMP_CHANGE_SEQ =
  'UPDATE approvals_meta SET change_seq = change_seq + 1 WHERE id = 1 RETURNING change_seq'

const INSERT_PENDING =
  'INSERT INTO approvals (approval_id, status, doc, server_name, tool_name, args_hash, ' +
  "requested_at, expires_at, change_seq) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)"

const SELECT_PENDING_DOCS =
  "SELECT doc FROM approvals WHERE status = 'pending' ORDER BY requested_at, approval_id"
const SELECT_PENDING_DOC =
  "SELECT doc FROM approvals WHERE approval_id = ? AND status = 'pending'"
const SELECT_RESOLVED_DOC =
  "SELECT doc FROM approvals WHERE approval_id = ? AND status = 'resolved'"
/** ULID primary keys: lexicographic DESC is chronological newest-first. */
const SELECT_NEWEST_RESOLVED_DOCS =
  "SELECT doc FROM approvals WHERE status = 'resolved' ORDER BY approval_id DESC LIMIT ?"

/** The gate's grant lookup: served by `idx_approvals_grant`, newest ULID first. */
const SELECT_RESOLVED_FOR_GRANT =
  "SELECT doc FROM approvals WHERE status = 'resolved' AND server_name = ? AND tool_name = ? " +
  'AND args_hash = ? ORDER BY approval_id DESC LIMIT ?'

/**
 * Retention: a bounded delete of the oldest settled requests. `resolved_at`
 * holds a fixed-width UTC ISO timestamp, so string comparison IS chronological
 * comparison and the cutoff needs no parsing. The inner SELECT keeps one call's
 * cost bounded, exactly as the file sweep it replaces was.
 */
const DELETE_OLD_RESOLVED =
  'DELETE FROM approvals WHERE approval_id IN (SELECT approval_id FROM approvals ' +
  "WHERE status = 'resolved' AND resolved_at < ? ORDER BY resolved_at LIMIT ?)"

const SELECT_LATEST_SEQ = 'SELECT change_seq FROM approvals_meta WHERE id = 1'
/** Every row touched after `?`, oldest change first, so a reader can replay in order. */
const SELECT_CHANGES_SINCE =
  'SELECT approval_id, status, doc FROM approvals WHERE change_seq > ? ORDER BY change_seq'

const RESOLVE_PENDING =
  "UPDATE approvals SET status = 'resolved', doc = ?, outcome = ?, resolved_at = ?, " +
  "change_seq = ? WHERE approval_id = ? AND status = 'pending'"

/** Matches the budget one document-store write gets (`store.ts`). */
const DEFAULT_TOTAL_WAIT_MS = 5_000
/** Cap of the exponential backoff between contended attempts. */
const RETRY_BACKOFF_CAP_MS = 32

/** An open queue database: the shared connection plus the identity of what it backs. */
export interface ApprovalsDb {
  readonly handle: SqliteHandle
  /** The `approvals/` directory this database serves; carried for the legacy import. */
  readonly baseDir: string
  /** Path of `state.db`; the identity storage failures are reported against. */
  readonly dbPath: string
}

/** `state.db` beside the queue directory — one database per journal directory. */
export function approvalsDbPath(baseDir: string): string {
  return dbPathFor(baseDir)
}

/**
 * Schema setup runs once per CONNECTION, not once per call: `openStateDbShared`
 * caches one connection per database per process, and a connection retired
 * after a `state.db` was replaced on disk is a different object, so the fresh
 * one gets its tables created again.
 */
const preparedHandles = new WeakMap<SqliteHandle, Promise<void>>()

/**
 * Opens (creating if needed) the queue's database and guarantees its schema.
 * Both `queue.ts` and `checkRecentApproval` come through here, so whatever
 * first-touch work is due happens on every entry path.
 */
export async function openApprovalsDb(baseDir: string): Promise<ApprovalsDb> {
  const dbPath = approvalsDbPath(baseDir)
  let handle: SqliteHandle
  try {
    handle = await openStateDbShared(dbPath)
  } catch (error: unknown) {
    rethrowClassified(dbPath, error, true)
  }

  const db: ApprovalsDb = { handle, baseDir, dbPath }
  let prepared = preparedHandles.get(handle)
  if (prepared === undefined) {
    prepared = prepare(db)
    preparedHandles.set(handle, prepared)
    // A failed preparation must not poison the connection forever.
    prepared.catch(() => preparedHandles.delete(handle))
  }
  try {
    await prepared
  } catch (error: unknown) {
    rethrowClassified(dbPath, error, true)
  }
  return db
}

async function prepare(db: ApprovalsDb): Promise<void> {
  // Idempotent and outside any transaction, exactly like the document tables:
  // the shared connection may have been opened by a document store first, with
  // none of the queue's tables present yet.
  const database = db.handle.db
  database.exec(CREATE_APPROVALS_TABLE)
  database.exec(CREATE_STATUS_SEQ_INDEX)
  database.exec(CREATE_SEQ_INDEX)
  database.exec(CREATE_GRANT_INDEX)
  database.exec(CREATE_APPROVALS_META_TABLE)
  database.exec(SEED_APPROVALS_META)
  // First touch of the process also picks up whatever an M4 build left in
  // `pending/`/`resolved/` — see `queue-import.ts` for the marker rules.
  await importLegacyApprovals(db)
}

/**
 * Runs `fn` inside `BEGIN IMMEDIATE`, retrying a contended writer with async
 * pacing: `node:sqlite` waits for the lock SYNCHRONOUSLY, so the per-statement
 * window stays small (`STATEMENT_BUSY_TIMEOUT_MS`) and the real waiting happens
 * here, off the event loop's back. `fn` MUST be synchronous — the adapter
 * rejects a promise, since COMMIT fires the moment the callback returns — and
 * MUST tolerate being re-run, because a busy retry replays the whole
 * transaction.
 */
export async function runWriteTransaction<R>(
  db: ApprovalsDb,
  fn: (database: StateDatabase) => R,
): Promise<R> {
  const deadlineAt = performance.now() + DEFAULT_TOTAL_WAIT_MS
  let attempt = 0
  for (;;) {
    try {
      return db.handle.transaction(fn)
    } catch (error: unknown) {
      // Out of budget, or not a contended writer at all: classify and give up.
      if (!isSqliteBusy(error) || performance.now() >= deadlineAt) {
        rethrowClassified(db.dbPath, error)
      }
    }
    attempt += 1
    await sleep(Math.min(2 ** attempt, RETRY_BACKOFF_CAP_MS) * Math.random())
  }
}

/**
 * Reserves the next change sequence. Called inside the same transaction as the
 * row it stamps, so a reader that saw sequence N can never miss a row that
 * committed at N+1.
 */
export function bumpChangeSeq(database: StateDatabase): number {
  const row = database.prepare(BUMP_CHANGE_SEQ).get() as { change_seq?: unknown } | undefined
  const next = row?.change_seq
  if (typeof next !== 'number' || !Number.isInteger(next)) {
    throw new Error('approvals_meta is missing its counter row')
  }
  return next
}

/** The indexed columns of a queue row; `doc` remains the source of truth. */
export interface PendingRowInput {
  readonly approvalId: string
  readonly doc: string
  readonly serverName: string
  readonly toolName: string
  readonly argsHash: string
  readonly requestedAt: string
  readonly expiresAt: string
  readonly changeSeq: number
}

export function insertPendingRow(database: StateDatabase, row: PendingRowInput): void {
  database
    .prepare(INSERT_PENDING)
    .run(
      row.approvalId,
      row.doc,
      row.serverName,
      row.toolName,
      row.argsHash,
      row.requestedAt,
      row.expiresAt,
      row.changeSeq,
    )
}

export interface ResolveRowInput {
  readonly approvalId: string
  readonly doc: string
  readonly outcome: string
  readonly resolvedAt: string
  readonly changeSeq: number
}

/**
 * The conditional write of the resolve race. `WHERE status = 'pending'` is the
 * serialization point: under `BEGIN IMMEDIATE` only one resolver can observe a
 * pending row, so `false` here means somebody else already resolved it.
 */
export function resolvePendingRow(database: StateDatabase, row: ResolveRowInput): boolean {
  const changes = database
    .prepare(RESOLVE_PENDING)
    .run(row.doc, row.outcome, row.resolvedAt, row.changeSeq, row.approvalId).changes
  return Number(changes) === 1
}

/** Every pending record's JSON text, oldest request first (the queue's list order). */
export function selectPendingDocs(database: StateDatabase): string[] {
  return docTexts(database.prepare(SELECT_PENDING_DOCS).all())
}

/** The pending record's JSON text, or `null` when the id is unknown or resolved. */
export function selectPendingDoc(database: StateDatabase, approvalId: string): string | null {
  return docText(database.prepare(SELECT_PENDING_DOC).get(approvalId))
}

/** The resolved record's JSON text, or `null` when the id is unknown or still pending. */
export function selectResolvedDoc(database: StateDatabase, approvalId: string): string | null {
  return docText(database.prepare(SELECT_RESOLVED_DOC).get(approvalId))
}

/** The `limit` newest resolved records, newest first; the read never exceeds `limit` rows. */
export function selectNewestResolvedDocs(database: StateDatabase, limit: number): string[] {
  return docTexts(database.prepare(SELECT_NEWEST_RESOLVED_DOCS).all(limit))
}

/** The indexed key of a grant lookup; the same triple the gate hashes a call into. */
export interface GrantLookupKey {
  readonly serverName: string
  readonly toolName: string
  readonly argsHash: string
}

/**
 * The `limit` newest resolved records for one call triple, newest first. The
 * columns only NARROW the candidates — every criterion that decides a grant is
 * checked against `doc`, which stays the source of truth.
 */
export function selectResolvedDocsForGrant(
  database: StateDatabase,
  key: GrantLookupKey,
  limit: number,
): string[] {
  return docTexts(
    database
      .prepare(SELECT_RESOLVED_FOR_GRANT)
      .all(key.serverName, key.toolName, key.argsHash, limit),
  )
}

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
 * The counter as it stands, which is the watermark a change reader carries
 * between polls. It is read from the meta row rather than from `MAX(change_seq)`
 * so retention deleting the newest resolved row can never rewind the watermark
 * and replay the whole table.
 */
export function selectLatestChangeSeq(database: StateDatabase): number {
  const row = database.prepare(SELECT_LATEST_SEQ).get() as { change_seq?: unknown } | undefined
  const latest = row?.change_seq
  return typeof latest === 'number' && Number.isInteger(latest) ? latest : 0
}

/** One changed row as a change reader sees it; `doc` still carries the whole record. */
export interface ApprovalChangeRow {
  readonly approvalId: string
  readonly status: string
  readonly doc: string
}

/**
 * Every row whose change sequence is past `sinceSeq`. Callers MUST read the
 * watermark (`selectLatestChangeSeq`) BEFORE this query: a write committing
 * between the two then shows up in this result while staying above the reported
 * watermark, so it is delivered again on the next poll — at-least-once, which a
 * caller can deduplicate. The other order would drop it silently.
 */
export function selectChangesSince(
  database: StateDatabase,
  sinceSeq: number,
): ApprovalChangeRow[] {
  const rows = database.prepare(SELECT_CHANGES_SINCE).all(sinceSeq)
  return rows.map(changeRow).filter((row): row is ApprovalChangeRow => row !== null)
}

function changeRow(row: unknown): ApprovalChangeRow | null {
  if (typeof row !== 'object' || row === null) return null
  const { approval_id: approvalId, status, doc } = row as Record<string, unknown>
  if (typeof approvalId !== 'string' || typeof status !== 'string') return null
  // A malformed `doc` is kept as an empty string rather than dropping the row:
  // the id and status are still the truth about WHAT changed, and the record
  // parser above this layer skips the unusable content (MALFORMED_SKIP).
  return { approvalId, status, doc: typeof doc === 'string' ? doc : '' }
}

/**
 * A non-text `doc` cannot come from this schema (STRICT, NOT NULL), so it means
 * a foreign table of the same name. Read paths of the queue skip malformed
 * content rather than throwing — the same rule the file-based queue applied to
 * unparseable files — so it is dropped here instead of being coerced.
 */
function docText(row: unknown): string | null {
  if (typeof row !== 'object' || row === null) return null
  const doc = (row as { doc?: unknown }).doc
  return typeof doc === 'string' ? doc : null
}

function docTexts(rows: readonly unknown[]): string[] {
  return rows.map(docText).filter((text): text is string => text !== null)
}
