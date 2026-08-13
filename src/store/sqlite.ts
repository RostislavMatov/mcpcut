import { chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../config.js'

/**
 * The single point of contact with `node:sqlite` (ADR-0006): opening, the
 * PRAGMA set, and write-transaction handling all live here, so the
 * experimental runtime API has exactly one place to change — the same move
 * as `src/protocol/mcp.ts` for the MCP spec. Stores write their own SQL
 * against the handle; they never import `node:sqlite` directly.
 */

export type SynchronousMode = 'normal' | 'full'

export interface SqliteOpenOptions {
  /**
   * Durability profile per database (ADR-0006): 'normal' for `state.db`
   * (control state, units of writes per hour), 'full' for `journal.db`
   * (a confirmed journal record must survive host power loss).
   */
  readonly synchronous: SynchronousMode
  /** How long SQLite waits for a contended lock before surfacing busy. */
  readonly busyTimeoutMs?: number
}

export interface SqliteHandle {
  /** Raw database handle; callers run SQL through it instead of importing `node:sqlite`. */
  readonly db: DatabaseSync
  readonly filePath: string
  /**
   * Runs `fn` inside `BEGIN IMMEDIATE … COMMIT`. IMMEDIATE takes the write
   * lock up front, so the read-modify-write inside is a true CAS: no other
   * process can commit between the read and the write. Rolls back and
   * rethrows on any failure. A lock still held after SQLite has waited the
   * busy timeout inside `BEGIN IMMEDIATE` surfaces as `SqliteBusyError`
   * with nothing written.
   *
   * `fn` MUST be synchronous: `COMMIT` fires the moment it returns, so work
   * scheduled behind an `await` would land outside the transaction. An async
   * callback is rejected at runtime rather than silently miscommitted.
   */
  transaction<T>(fn: (db: DatabaseSync) => T): T
  /** Closes the database. Idempotent: closing an already-closed handle is a no-op. */
  close(): void
}

/** Matches the cross-process lock budget the JSON stores used (`LOCK_TOTAL_WAIT_MS`). */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000

/**
 * Raised when the write lock stayed contended past the busy timeout;
 * nothing was written. SQLite itself retries acquisition for the whole
 * `busy_timeout` budget inside `BEGIN IMMEDIATE`, so by the time this
 * surfaces the wait has already happened.
 */
export class SqliteBusyError extends Error {
  constructor(filePath: string) {
    super(
      `Database "${filePath}" is locked by another process; ` +
        `gave up after waiting the busy timeout`,
    )
    this.name = 'SqliteBusyError'
  }
}

/** Raised when the database could not be opened or its PRAGMA set applied. */
export class SqliteOpenError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`Could not open database "${filePath}": ${describeCause(cause)}`, { cause })
    this.name = 'SqliteOpenError'
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Primary result code SQLITE_BUSY. `node:sqlite` currently reports primary
 * codes on `errcode`; if a future runtime switches to extended codes
 * (e.g. SQLITE_BUSY_TIMEOUT = 773), this stops matching — that lands under
 * the ADR-0006 revisit trigger "`node:sqlite` меняет API".
 */
const SQLITE_BUSY_ERRCODE = 5

function isBusyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'errcode' in error &&
    (error as { errcode?: unknown }).errcode === SQLITE_BUSY_ERRCODE
  )
}

/**
 * Opens (creating if needed) a database at `filePath` with the ADR-0006
 * PRAGMA set applied. Ownership model matches the journal: directory 0700,
 * file 0600 — control state is as sensitive as the journal itself.
 * Any open-time failure rejects with `SqliteOpenError`.
 */
export async function openSqlite(
  filePath: string,
  options: SqliteOpenOptions,
): Promise<SqliteHandle> {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError(`busyTimeoutMs must be a non-negative integer, got ${busyTimeoutMs}`)
  }

  const dir = dirname(filePath)
  let db: DatabaseSync
  try {
    await mkdir(dir, { recursive: true, mode: JOURNAL_DIR_MODE })
    // mkdir's mode is masked by the process umask and ignored for a directory
    // that already exists — chmod unconditionally, like the JSON stores do.
    await chmod(dir, JOURNAL_DIR_MODE)

    // The constructor and PRAGMAs are synchronous by design of node:sqlite;
    // only the fs setup above has an async form.
    db = new DatabaseSync(filePath)
  } catch (error: unknown) {
    throw new SqliteOpenError(filePath, error)
  }

  try {
    // SQLite creates -wal/-shm side files with the database file's
    // permissions, so tightening the main file here covers all three.
    await chmod(filePath, JOURNAL_FILE_MODE)

    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(`PRAGMA synchronous = ${options.synchronous === 'full' ? 'FULL' : 'NORMAL'}`)
    db.exec('PRAGMA foreign_keys = ON')
  } catch (error: unknown) {
    db.close()
    throw new SqliteOpenError(filePath, error)
  }

  return {
    db,
    filePath,
    transaction: (fn) => runTransaction(db, filePath, fn),
    close: makeIdempotentClose(db),
  }
}

function runTransaction<T>(
  db: DatabaseSync,
  filePath: string,
  fn: (database: DatabaseSync) => T,
): T {
  try {
    // SQLite waits busy_timeout inside this call; only a lock still held
    // after that whole budget lands in the catch.
    db.exec('BEGIN IMMEDIATE')
  } catch (error: unknown) {
    if (isBusyError(error)) throw new SqliteBusyError(filePath)
    throw error
  }

  try {
    const result = fn(db)
    if (result instanceof Promise) {
      throw new TypeError(
        'transaction() callback must be synchronous: COMMIT fires when it returns, ' +
          'so awaited work would run outside the transaction',
      )
    }
    db.exec('COMMIT')
    return result
  } catch (error: unknown) {
    // ROLLBACK must never mask the original failure: a transaction that
    // died from a lost connection cannot roll back either, and reporting
    // that instead would hide the root cause.
    try {
      db.exec('ROLLBACK')
    } catch {
      // intentionally swallowed — the original error is what matters
    }
    throw error
  }
}

function makeIdempotentClose(db: DatabaseSync): () => void {
  let isClosed = false
  return () => {
    if (isClosed) return
    isClosed = true
    db.close()
  }
}
