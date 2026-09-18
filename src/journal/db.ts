import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { openSqlite, type SqliteHandle } from '../store/sqlite.js'
import { GENESIS_PREV_HASH, linkHashOf } from './chain.js'

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
 *
 * `prev_hash`/`record_hash` (M5 wave 3) are the hash chain: `insertRecordRows`
 * is the ONLY place a row is ever written, so it is the one and only place
 * the chain is computed — there is no unchained insert path, including the
 * bulk importer (`import.ts`), which calls this same function. Rows written
 * before the chain existed keep both columns `NULL`: that is deliberate, not
 * a gap to fill in later. `NULL` means "written before the chain was
 * enabled, not attested" — there is no retroactive signing of old rows (the
 * plan rejects it explicitly: a fabricated retro-chain would claim integrity
 * the pre-M5 journal never actually had).
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
 *
 * `prev_hash`/`record_hash` are nullable TEXT — valid under STRICT, which
 * only forbids storing a value of the WRONG type in a typed column, not
 * storing no value at all in a column with no `NOT NULL`. A fresh database
 * gets them from this DDL; an existing one gets them via the `ALTER TABLE`
 * below, applied unconditionally (idempotently) on every open. See the
 * module doc for what `NULL` in these columns means.
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
  'doc TEXT NOT NULL, ' +
  'prev_hash TEXT, ' +
  'record_hash TEXT) STRICT'

/** Column names `ensureChainColumns` adds to a database that predates the chain. */
const PREV_HASH_COLUMN = 'prev_hash'
const RECORD_HASH_COLUMN = 'record_hash'

/** Session-scoped reads in `seq` order: paging through one session's records. */
const CREATE_SESSION_SEQ_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_journal_session_seq ON journal_records(session_id, seq)'
/** Session-scoped reads filtered by kind (e.g. only `decision` records). */
const CREATE_SESSION_KIND_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_journal_session_kind ON journal_records(session_id, kind)'

/** See the module doc: a marker without rows is legitimate once retention lands. */
const CREATE_IMPORTED_SESSIONS_TABLE =
  'CREATE TABLE IF NOT EXISTS imported_sessions (session_id TEXT PRIMARY KEY) STRICT'

/**
 * Retention markers (M5 wave 6): one row per `mcpcut prune`, holding the
 * `seq` boundary of the deleted prefix and the `record_hash` the surviving
 * chain now hangs from. The semantics live in `prune.ts`; the DDL lives here
 * because this is where the journal's schema is created, and both the writer
 * (`prune.ts`) and the readers (`chain-verify.ts`, `insertRecordRows` below)
 * must find the table present on every open, including a database that
 * predates retention.
 *
 * Append-only by shape: `pruned_through_seq` is the primary key and `seq` is
 * `AUTOINCREMENT`, so a second prune can only ever insert a HIGHER boundary --
 * a marker cannot be silently rewritten to claim a smaller deletion than
 * happened.
 */
const CREATE_PRUNE_MARKER_TABLE =
  'CREATE TABLE IF NOT EXISTS journal_prune_marker (' +
  'pruned_through_seq INTEGER PRIMARY KEY, ' +
  'head_record_hash TEXT, ' +
  'pruned_at TEXT NOT NULL, ' +
  'deleted_count INTEGER NOT NULL, ' +
  'signature_format_version INTEGER, ' +
  'signed_at TEXT, ' +
  'key_fingerprint TEXT, ' +
  'signature TEXT) STRICT'

const INSERT_RECORD_ROW =
  'INSERT INTO journal_records (session_id, record_id, ts, direction, kind, method, doc, ' +
  'prev_hash, record_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'

/**
 * The chain head: the `record_hash` of the most recently inserted CHAINED
 * row, or `undefined` when there is none yet. `WHERE record_hash IS NOT
 * NULL` is load-bearing, not defensive: a database that already holds
 * pre-chain rows (see the module doc) must start its chain from
 * `GENESIS_PREV_HASH` at the first chained row, never inherit a `NULL` as
 * if it were a real head — concatenating a literal "NULL" into a hash would
 * both be wrong and silently "attest" rows that came before attestation
 * existed.
 */
const SELECT_CHAIN_HEAD =
  'SELECT record_hash AS recordHash FROM journal_records ' +
  'WHERE record_hash IS NOT NULL ORDER BY seq DESC LIMIT 1'

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
    // Migrates a database created before the chain existed: on a fresh
    // database the columns are already there via the DDL above, so this is
    // a no-op (guarded by the table_info check below) — safe to run on
    // every open, not just the first one ever.
    ensureChainColumns(handle)
    handle.db.exec(CREATE_SESSION_SEQ_INDEX)
    handle.db.exec(CREATE_SESSION_KIND_INDEX)
    handle.db.exec(CREATE_IMPORTED_SESSIONS_TABLE)
    handle.db.exec(CREATE_PRUNE_MARKER_TABLE)
    const identity = await stat(dbPath)
    return { handle, dev: identity.dev, ino: identity.ino }
  } catch (error: unknown) {
    handle.close()
    throw error
  }
}

/**
 * Adds `prev_hash`/`record_hash` to a `journal_records` table that predates
 * the chain (M5 wave 3). `ALTER TABLE ADD COLUMN` errors if the column
 * already exists, so each column is guarded by its own `PRAGMA table_info`
 * check rather than run unconditionally — that guard is what makes this
 * function safe to call on EVERY open, including a fresh database whose
 * `CREATE TABLE` already added both columns.
 */
function ensureChainColumns(handle: SqliteHandle): void {
  if (!hasColumn(handle, PREV_HASH_COLUMN)) {
    handle.db.exec(`ALTER TABLE journal_records ADD COLUMN ${PREV_HASH_COLUMN} TEXT`)
  }
  if (!hasColumn(handle, RECORD_HASH_COLUMN)) {
    handle.db.exec(`ALTER TABLE journal_records ADD COLUMN ${RECORD_HASH_COLUMN} TEXT`)
  }
}

/** True when `journal_records` already has `column`. `column` is always one of this module's own constants, never external input. */
function hasColumn(handle: SqliteHandle, column: string): boolean {
  const rows = handle.db.prepare('PRAGMA table_info(journal_records)').all()
  return rows.some((row) => row['name'] === column)
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
 * Inserts `rows` via a prepared statement, one `INSERT` per row, CHAINING
 * them as it goes (M5 wave 3) — this is the one and only row-insert path in
 * the whole journal (`batch-writer.ts` and the bulk importer both call
 * nothing else), so there is no way to append a row without a chain link.
 *
 * Callers wrap this in `handle.transaction(...)` so a batch commits
 * atomically; this function itself runs no transaction so it composes with
 * the batch writer's own retry-the-whole-batch semantics. That composition
 * is exactly what makes the chain safe under concurrency: the ONE head
 * read below (`SELECT_CHAIN_HEAD`) happens on `db`, the connection handed
 * to us BY the transaction callback — i.e. strictly AFTER `BEGIN IMMEDIATE`
 * has taken the write lock. `withBusyRetries` (`batch-writer.ts`) replays
 * this WHOLE function on a busy lock, and another process's sink may have
 * appended between attempts, so a head read taken before the lock (e.g.
 * hoisted out to the caller) could hand every retry the SAME stale
 * `prevHash` and fork the chain. Do not hoist this read — it must stay
 * inside the function that runs inside the transaction.
 *
 * The head is read ONCE per batch, then folded across `rows` in memory
 * (`prev` reassigned per row): one `SELECT` for up to
 * `JOURNAL_BATCH_MAX_RECORDS` rows, not one per row, is what keeps chaining
 * from costing the batch its throughput (plan risk: chain SELECT vs. the
 * ≥100k rec/s gate).
 */
export function insertRecordRows(db: JournalDatabase, rows: readonly JournalRecordRow[]): void {
  if (rows.length === 0) return

  const insert = db.prepare(INSERT_RECORD_ROW)
  let prev = chainHeadOf(db)
  for (const row of rows) {
    const recordHash = linkHashOf(prev, row.doc)
    insert.run(
      row.sessionId,
      row.recordId,
      row.ts,
      row.direction,
      row.kind,
      row.method,
      row.doc,
      prev,
      recordHash,
    )
    prev = recordHash
  }
}

/**
 * The current chain head's `record_hash`: the last attested row's, or -- when
 * no attested row is left -- the head recorded by the most recent prune, or
 * `GENESIS_PREV_HASH` on a journal that never had either. See
 * `insertRecordRows`.
 *
 * The prune fallback is not a nicety (M5 wave 6). Pruning every row leaves the
 * table empty, and an empty table would restart the next write at genesis --
 * producing a journal that verifies perfectly clean while silently claiming
 * nothing was ever written before it. Chaining onto the marker instead keeps
 * the deleted history's last link inside the chain that continues, so a
 * pruned journal is visibly a CONTINUATION rather than a fresh one.
 */
function chainHeadOf(db: JournalDatabase): string {
  const head = db.prepare(SELECT_CHAIN_HEAD).get() as { recordHash: unknown } | undefined
  if (head !== undefined && typeof head.recordHash === 'string') return head.recordHash
  const marker = db.prepare(SELECT_PRUNE_MARKER_HEAD).get() as { headRecordHash: unknown } | undefined
  return marker !== undefined && typeof marker.headRecordHash === 'string'
    ? marker.headRecordHash
    : GENESIS_PREV_HASH
}

/**
 * The head of the most recently pruned prefix, ignoring markers that recorded
 * no hash (an all-pre-chain prefix, which leaves the chain starting at genesis
 * exactly as before). Ordered by the boundary `seq`, the database's own
 * monotonic counter, never by a wall-clock timestamp.
 */
const SELECT_PRUNE_MARKER_HEAD =
  'SELECT head_record_hash AS headRecordHash FROM journal_prune_marker ' +
  'WHERE head_record_hash IS NOT NULL ORDER BY pruned_through_seq DESC LIMIT 1'
