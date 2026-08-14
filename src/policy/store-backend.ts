import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isSqliteBusy, openSqlite, type SqliteHandle } from '../store/sqlite.js'

/**
 * Low-level backing of the state stores: the `state.db` schema, the shared
 * per-process connection cache, the document/marker statements, and the error
 * classes every store caller catches. Split out of `store.ts` so the store
 * logic and its SQL substrate each stay inside the file-size budget;
 * `store-migrate.ts` builds on the same primitives.
 */

/** The database handed to a transaction callback, named without importing `node:sqlite` here. */
export type StateDatabase = Parameters<Parameters<SqliteHandle['transaction']>[0]>[0]

/** One database per journal directory; the document's basename is its row key. */
const STATE_DB_FILE_NAME = 'state.db'

/**
 * Deliberately small: `node:sqlite` waits for a contended writer lock
 * SYNCHRONOUSLY, freezing the whole event loop for the wait. The store's
 * update loop owns the real budget (`totalWaitMs`) and waits between attempts
 * with an async sleep, so a held lock costs the process at most this many
 * milliseconds of blocked loop per attempt, not the whole budget at once.
 */
export const STATEMENT_BUSY_TIMEOUT_MS = 50

/**
 * STRICT rejects a non-TEXT `doc` at write time instead of storing whatever
 * was handed over, keeping "the row is JSON text" an enforced invariant
 * rather than a convention. `rev` is the optimistic-CAS token: bumped on
 * every committed update, matched in the conditional write.
 */
const CREATE_DOCUMENTS_TABLE =
  'CREATE TABLE IF NOT EXISTS documents ' +
  '(name TEXT PRIMARY KEY, doc TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0) STRICT'

/**
 * Which documents were imported from a legacy `*.json` file. Written in the
 * SAME transaction as the imported row, and consulted whenever a row is
 * missing: a marker without a row means state.db lost data (e.g. it was
 * "backed up" without its `-wal` sidecar, where the rows actually live), and
 * re-importing the stale legacy file would silently resurrect credentials
 * revoked since — the store refuses loudly instead.
 */
const CREATE_MIGRATED_TABLE =
  'CREATE TABLE IF NOT EXISTS migrated_documents (name TEXT PRIMARY KEY) STRICT'

const SELECT_DOCUMENT = 'SELECT doc, rev FROM documents WHERE name = ?'
const SELECT_MARKER = 'SELECT name FROM migrated_documents WHERE name = ?'
const INSERT_DOCUMENT = 'INSERT INTO documents (name, doc, rev) VALUES (?, ?, 1)'
const INSERT_MARKER = 'INSERT OR IGNORE INTO migrated_documents (name) VALUES (?)'
const UPDATE_DOCUMENT = 'UPDATE documents SET doc = ?, rev = rev + 1 WHERE name = ? AND rev = ?'

/** Raised by the stores when persisted state exists but cannot be trusted. */
export class StoreCorruptError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`Policy store "${filePath}" is corrupt: ${describeCause(cause)}`, { cause })
    this.name = 'StoreCorruptError'
  }
}

/**
 * A `SyntaxError` from `JSON.parse` embeds a snippet of the offending input
 * in its message; for a store this generic that snippet could be anything the
 * file held, and error messages must name paths, never contents.
 */
function describeCause(cause: unknown): string {
  if (cause instanceof SyntaxError) return 'not valid JSON'
  return cause instanceof Error ? cause.message : String(cause)
}

/** Raised by the stores when a write could not land inside its budget; nothing was written. */
export class StoreLockError extends Error {
  constructor(filePath: string, reason?: string) {
    super(
      reason === undefined
        ? `Policy store "${filePath}" is locked by another process; timed out acquiring the lock`
        : `Policy store "${filePath}": ${reason}; nothing was written`,
    )
    this.name = 'StoreLockError'
  }
}

/** One document row as the CAS sees it; `null` when the document has never been written. */
export interface DocumentRow {
  readonly doc: string
  readonly rev: number
}

/**
 * Reads the row for `name` outside any transaction (WAL readers never block
 * the writer). A row that exists but does not carry text-and-integer is
 * corruption — treating it as "absent" would route into the legacy-import /
 * default path, the exact fail-open this module forbids.
 */
export function selectDocument(
  db: StateDatabase,
  name: string,
  filePath: string,
): DocumentRow | null {
  const row = db.prepare(SELECT_DOCUMENT).get(name) as
    | { doc?: unknown; rev?: unknown }
    | undefined
  if (row === undefined) return null
  // No coercion before the check: a foreign (non-STRICT) table storing rev as
  // text would survive Number('7') and then never match the CAS's integer
  // binding, turning corruption into a phantom "concurrent writers" report.
  const rev = row.rev
  if (typeof row.doc !== 'string' || typeof rev !== 'number' || !Number.isInteger(rev)) {
    throw new StoreCorruptError(
      filePath,
      new Error(`state row "${name}" is malformed (non-text doc or non-integer rev)`),
    )
  }
  return { doc: row.doc, rev }
}

/**
 * Records that `name` was imported from legacy files. Written in the SAME
 * transaction as the rows it covers, and `OR IGNORE` so a racing importer that
 * lost is a no-op rather than an error.
 */
export function insertMigrationMarker(db: StateDatabase, name: string): void {
  db.prepare(INSERT_MARKER).run(name)
}

/** True when `name` was imported from a legacy file at some point in this database's life. */
export function markerPresent(db: StateDatabase, name: string): boolean {
  return db.prepare(SELECT_MARKER).get(name) !== undefined
}

/**
 * Refuses to proceed when the document was migrated but its row is gone:
 * falling back to the legacy file here would resurrect whatever it held at
 * migration time (revoked agents included) as live, authoritative state.
 */
export function assertNotPreviouslyMigrated(
  db: StateDatabase,
  name: string,
  filePath: string,
): void {
  if (!markerPresent(db, name)) return
  throw new StoreCorruptError(
    filePath,
    new Error(
      `document "${name}" was migrated into state.db but its row is missing — ` +
        'refusing to re-import the stale legacy file; restore state.db from a backup ' +
        'that includes its -wal sidecar',
    ),
  )
}

/**
 * First write of a document, atomic with its migration marker when the text
 * came from a legacy file. Returns `false` when a concurrent writer created
 * the row first (their row is current; the caller re-reads).
 */
export function insertDocumentFirstWrite(
  handle: SqliteHandle,
  name: string,
  filePath: string,
  text: string,
  isLegacyImport: boolean,
): boolean {
  return handle.transaction((db) => {
    if (selectDocument(db, name, filePath) !== null) return false
    db.prepare(INSERT_DOCUMENT).run(name, text)
    if (isLegacyImport) insertMigrationMarker(db, name)
    return true
  })
}

/** The conditional write of the optimistic CAS; `false` = lost the race, nothing written. */
export function updateDocumentCas(
  db: StateDatabase,
  name: string,
  text: string,
  expectedRev: number,
): boolean {
  return Number(db.prepare(UPDATE_DOCUMENT).run(text, name, expectedRev).changes) === 1
}

/** `state.db` for the document identified by `filePath`: one database per directory. */
export function dbPathFor(filePath: string): string {
  return join(dirname(filePath), STATE_DB_FILE_NAME)
}

/** The document's row key: its basename, so `<dir>/agents.json` and `<dir>/registry.json` coexist. */
export function keyFor(filePath: string): string {
  return basename(filePath)
}

/** The cached connection plus the on-disk identity of the file it was opened against. */
interface CachedStateDb {
  readonly handle: SqliteHandle
  readonly dev: number
  readonly ino: number
}

/**
 * One connection per database PER PROCESS, shared by every store instance —
 * `ui` constructs a store per poll tick and `inventory` one per approval, so
 * a connection per instance accumulates file descriptors at GC's discretion.
 * The cache is keyed by path so tests in separate temp dirs stay isolated.
 *
 * Every acquisition re-checks that the path still resolves to the SAME file
 * (dev+inode): a `state.db` replaced or deleted on disk (backup restore,
 * journal-dir reset) would otherwise be silently ignored for the rest of the
 * process's life — a long-lived `serve` would keep authorizing agents out of
 * the unlinked old database. On mismatch the stale handle is retired (any
 * operation still in flight on it fails loudly, which is the correct side of
 * that trade) and a fresh connection is opened against the current file.
 */
const sharedHandles = new Map<string, Promise<CachedStateDb>>()

export async function openStateDbShared(dbPath: string): Promise<SqliteHandle> {
  for (;;) {
    let pending = sharedHandles.get(dbPath)
    if (pending === undefined) {
      pending = openStateDb(dbPath)
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

/** True while `dbPath` still points at the file the cached connection was opened against. */
async function isSameFile(dbPath: string, cached: CachedStateDb): Promise<boolean> {
  try {
    const now = await stat(dbPath)
    return now.dev === cached.dev && now.ino === cached.ino
  } catch (error: unknown) {
    if (isEnoent(error)) return false
    throw error
  }
}

async function openStateDb(dbPath: string): Promise<CachedStateDb> {
  const handle = await openSqlite(dbPath, {
    synchronous: 'normal',
    busyTimeoutMs: STATEMENT_BUSY_TIMEOUT_MS,
  })
  try {
    // Idempotent and outside any transaction: wave 3 adds its own tables to
    // the same database the same way.
    handle.db.exec(CREATE_DOCUMENTS_TABLE)
    handle.db.exec(CREATE_MIGRATED_TABLE)
    const identity = await stat(dbPath)
    return { handle, dev: identity.dev, ino: identity.ino }
  } catch (error: unknown) {
    handle.close()
    throw error
  }
}

/**
 * The one place a storage failure is classified for callers (used by
 * `store.ts` and `store-migrate.ts`, so `serve` and `mcp-journal migrate`
 * can never drift into reporting the same condition differently): a
 * contended writer — wherever it surfaced, including wrapped inside an
 * open failure — is `StoreLockError`; an open failure is corruption;
 * anything already typed passes through.
 */
export function rethrowClassified(filePath: string, error: unknown, isOpenFailure = false): never {
  if (isSqliteBusy(error)) {
    throw new StoreLockError(filePath, 'the writer lock stayed contended past the busy timeout')
  }
  if (error instanceof StoreCorruptError || error instanceof StoreLockError) throw error
  if (isOpenFailure) throw new StoreCorruptError(filePath, error)
  throw error
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/** Legacy `*.json` written by a pre-M4.5 build; `null` when there is none. */
export async function loadLegacyTextAt(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error: unknown) {
    if (isEnoent(error)) return null
    throw new StoreCorruptError(filePath, error)
  }
}
