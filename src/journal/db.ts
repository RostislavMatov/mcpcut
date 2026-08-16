import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { openSqlite, type SqliteHandle } from '../store/sqlite.js'

/**
 * The single point of contact with `journal.db`'s schema and connection
 * lifecycle (ADR-0006: two databases per journal directory — this one beside
 * `state.db`, never sharing its connection cache or PRAGMA profile). Every
 * piece of journal SQL lives here or in modules that take a handle from
 * `openJournalDbShared`; `node:sqlite` itself stays confined to
 * `src/store/sqlite.ts`.
 *
 * Opened with `synchronous: 'full'`, unlike `state.db`'s `'normal'`: a
 * confirmed journal record is the audit product's core claim ("the record
 * exists"), so it must survive a host power loss, not just a process crash —
 * `state.db` only needs to survive the latter.
 *
 * `imported_sessions` marks which sessions were bulk-imported from legacy
 * `*.jsonl` files (`import.ts`, a later wave). Unlike `state.db`'s
 * `migrated_documents` table, a marker with zero rows raises nothing here:
 * once retention (a later wave) starts pruning old records, an imported
 * session legitimately ends up with no rows left. The journal is
 * append-oriented evidence, not authorization state — there is no live
 * grant that a vanished row could silently resurrect, so the loud
 * `assertNotPreviouslyMigrated`-style refusal the document stores use would
 * be alarming the operator over a normal outcome.
 */

/** The database handed to a transaction callback, named without importing `node:sqlite` here. */
export type JournalDatabase = Parameters<Parameters<SqliteHandle['transaction']>[0]>[0]

/** One database per journal directory, beside `state.db`. */
export const JOURNAL_DB_FILE_NAME = 'journal.db'

/**
 * `AUTOINCREMENT` is deliberate, not decorative: plain `rowid` reuses the
 * table's max value after a `DELETE`, and the M5 hash chain needs `seq` to
 * stay forever-monotonic even after retention prunes old rows — a reused
 * `seq` would let two different records claim the same link in the chain.
 * `doc` is the source of truth (the whole `JournalRecord` as JSON, unchanged
 * shape); the other columns are denormalized copies that exist only to keep
 * indexed scans narrow, exactly like the approvals queue's columns beside
 * its own `doc`.
 */
const CREATE_JOURNAL_RECORDS_TABLE =
  'CREATE TABLE IF NOT EXISTS journal_records (' +
  'seq INTEGER PRIMARY KEY AUTOINCREMENT, ' +
  'session_id TEXT NOT NULL, ' +
  'record_id TEXT NOT NULL, ' +
  'ts TEXT NOT NULL, ' +
  'direction TEXT NOT NULL, ' +
  'kind TEXT NOT NULL, ' +
  'method TEXT, ' +
  'doc TEXT NOT NULL) STRICT'

/** Session-scoped reads in `seq` order: paging through one session's records. */
const CREATE_SESSION_SEQ_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_journal_session_seq ON journal_records(session_id, seq)'
/** Session-scoped reads filtered by kind (e.g. only `decision` records). */
const CREATE_SESSION_KIND_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_journal_session_kind ON journal_records(session_id, kind)'

/** See the module doc: a marker without rows is legitimate once retention lands. */
const CREATE_IMPORTED_SESSIONS_TABLE =
  'CREATE TABLE IF NOT EXISTS imported_sessions (session_id TEXT PRIMARY KEY) STRICT'

const INSERT_RECORD_ROW =
  'INSERT INTO journal_records (session_id, record_id, ts, direction, kind, method, doc) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?)'

/**
 * Deliberately small, mirroring `STATEMENT_BUSY_TIMEOUT_MS`
 * (`policy/store-backend.ts`) for the same reason: `node:sqlite` waits for a
 * contended writer lock SYNCHRONOUSLY, freezing the event loop for the wait.
 * A caller's own retry budget (the batch writer's async pacing, a later
 * wave) waits between attempts with an async sleep, so a held lock costs the
 * process at most this many milliseconds of blocked loop per attempt, not
 * the whole budget at once.
 */
const JOURNAL_STATEMENT_BUSY_TIMEOUT_MS = 50

/** `journal.db` for the journal directory `journalDir`: one database per directory. */
export function journalDbPathFor(journalDir: string): string {
  return join(journalDir, JOURNAL_DB_FILE_NAME)
}

/** The cached connection plus the on-disk identity of the file it was opened against. */
interface CachedJournalDb {
  readonly handle: SqliteHandle
  readonly dev: number
  readonly ino: number
}

/**
 * One connection per database PER PROCESS (own cache, deliberately not
 * shared with `state.db`'s: different PRAGMA profile, `openStateDbShared`
 * would apply the wrong `synchronous` mode). Mirrors
 * `policy/store-backend.ts`'s `openStateDbShared` almost literally —
 * see that module's doc comment for the full dev/ino re-check rationale.
 */
const sharedHandles = new Map<string, Promise<CachedJournalDb>>()

export async function openJournalDbShared(dbPath: string): Promise<SqliteHandle> {
  for (;;) {
    let pending = sharedHandles.get(dbPath)
    if (pending === undefined) {
      pending = openJournalDb(dbPath)
      sharedHandles.set(dbPath, pending)
      // A failed open must not poison the process forever: drop the memo so a
      // later call can retry (a directory that was not writable yet, say).
      pending.catch(() => sharedHandles.delete(dbPath))
    }

    const cached = await pending
    if (await isSameFile(dbPath, cached)) return cached.handle

    // Retire the handle to the vanished/replaced file; only the first caller
    // to notice does the retirement, the rest loop and reopen.
    if (sharedHandles.get(dbPath) === pending) {
      sharedHandles.delete(dbPath)
      cached.handle.close()
    }
  }
}

/**
 * The journal directory's database, or null when the directory has none.
 *
 * The `stat` probe is the whole point: `openJournalDbShared` would create the
 * file, and a read has no business doing that. A directory that cannot be
 * probed at all (a permission error, say) is a real failure and propagates —
 * quietly falling back to an empty answer would present half a journal as the
 * whole one.
 */
export async function openJournalDbIfPresent(journalDir: string): Promise<SqliteHandle | null> {
  const dbPath = journalDbPathFor(journalDir)
  try {
    await stat(dbPath)
  } catch (error: unknown) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
  return openJournalDbShared(dbPath)
}

function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** True while `dbPath` still points at the file the cached connection was opened against. */
async function isSameFile(dbPath: string, cached: CachedJournalDb): Promise<boolean> {
  try {
    const now = await stat(dbPath)
    return now.dev === cached.dev && now.ino === cached.ino
  } catch (error: unknown) {
    if (isEnoent(error)) return false
    throw error
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

async function openJournalDb(dbPath: string): Promise<CachedJournalDb> {
  const handle = await openSqlite(dbPath, {
    synchronous: 'full',
    busyTimeoutMs: JOURNAL_STATEMENT_BUSY_TIMEOUT_MS,
  })
  try {
    // Idempotent and outside any transaction, same as state.db's tables.
    handle.db.exec(CREATE_JOURNAL_RECORDS_TABLE)
    handle.db.exec(CREATE_SESSION_SEQ_INDEX)
    handle.db.exec(CREATE_SESSION_KIND_INDEX)
    handle.db.exec(CREATE_IMPORTED_SESSIONS_TABLE)
    const identity = await stat(dbPath)
    return { handle, dev: identity.dev, ino: identity.ino }
  } catch (error: unknown) {
    handle.close()
    throw error
  }
}

/** One journal record's columns as a row; `doc` is the whole `JournalRecord` as JSON text. */
export interface JournalRecordRow {
  readonly sessionId: string
  readonly recordId: string
  readonly ts: string
  readonly direction: string
  readonly kind: string
  readonly method: string | null
  readonly doc: string
}

/**
 * Inserts `rows` via a prepared statement, one `INSERT` per row. Callers wrap
 * this in `handle.transaction(...)` so a batch commits atomically; this
 * function itself runs no transaction so it composes with the batch writer's
 * own retry-the-whole-batch semantics.
 */
export function insertRecordRows(db: JournalDatabase, rows: readonly JournalRecordRow[]): void {
  const insert = db.prepare(INSERT_RECORD_ROW)
  for (const row of rows) {
    insert.run(row.sessionId, row.recordId, row.ts, row.direction, row.kind, row.method, row.doc)
  }
}
