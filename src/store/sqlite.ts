import { chmod, mkdir, open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../config.js'

/**
 * The single point of contact with `node:sqlite` (ADR-0006): opening, the
 * PRAGMA set, and write-transaction handling all live here, so the
 * experimental runtime API has exactly one place to change — the same move
 * as `src/protocol/mcp.ts` for the MCP spec. Stores write their own SQL
 * against the handle; they never import `node:sqlite` directly.
 */

/**
 * The driver is required, not statically imported — and the reason is WHEN,
 * not how.
 *
 * A builtin ES module is compiled during the LINK phase of the entry's module
 * graph, which finishes before the first line of any module body runs. So the
 * `ExperimentalWarning` `node:sqlite` prints on load was already queued before
 * the CLI could install its one-line filter, and headed every command's stderr
 * and both daemon logs (user-journey smoke 2026-09-18, UX-7). `createRequire`
 * moves the load to the evaluation of THIS module, which happens after
 * `cli/warning-filter-install.ts` — the entry's first import — has run.
 *
 * Types still come from `node:sqlite` through `import type` above (erased, so
 * it links nothing) and the cast below, so nothing about the API surface is
 * loosened; only the moment of loading moved. The architecture test that pins
 * this module as the sole point of contact reads import specifiers and still
 * sees exactly one file naming the driver.
 */
const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

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

/**
 * Raised when the online backup could not be written — including the case
 * that matters most to an operator: the destination file already exists, so
 * an earlier snapshot would have been overwritten (see `backupSqlite`).
 */
export class SqliteBackupError extends Error {
  constructor(filePath: string, destPath: string, cause: unknown) {
    super(
      `Could not back up database "${filePath}" to "${destPath}": ${describeCause(cause)}`,
      { cause },
    )
    this.name = 'SqliteBackupError'
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

/**
 * Primary result codes that mean the FILE is damaged, not the operation:
 * SQLITE_CORRUPT (a malformed disk image) and SQLITE_NOTADB (the header is
 * not a database's at all — what a crash or a full disk leaves behind).
 * Same `errcode` caveat as `SQLITE_BUSY_ERRCODE` above.
 */
const SQLITE_CORRUPT_ERRCODE = 11
const SQLITE_NOTADB_ERRCODE = 26

/** How deep the `cause` chain is walked; guards against cyclic causes. */
const CAUSE_CHAIN_LIMIT = 5

/**
 * True for a contended-writer failure, whether already wrapped by this
 * adapter (`SqliteBusyError`, or a busy PRAGMA inside `SqliteOpenError`) or
 * raw from a single statement executed outside `transaction()`. The `cause`
 * chain is walked so a wrapped busy is never misread as corruption — the
 * operator runbooks for "contended" and "corrupt" are opposites.
 * Exported so stores never inspect `node:sqlite` error codes themselves.
 */
export function isSqliteBusy(error: unknown): boolean {
  return matchesCauseChain(
    error,
    (candidate) => candidate instanceof SqliteBusyError || isBusyError(candidate),
  )
}

/**
 * True for the opposite runbook: the file itself is damaged. Classified by
 * result code rather than message text, and walked over the `cause` chain so
 * a corruption wrapped in `SqliteOpenError` still reads as corruption —
 * `openSqlite` wraps every open-time failure alike, and a permission or busy
 * failure must NOT be reported to the operator as damage. Exported for the
 * same reason as `isSqliteBusy`: callers never inspect `node:sqlite` codes.
 */
export function isSqliteCorruption(error: unknown): boolean {
  return matchesCauseChain(
    error,
    (candidate) =>
      hasErrcode(candidate, SQLITE_CORRUPT_ERRCODE) || hasErrcode(candidate, SQLITE_NOTADB_ERRCODE),
  )
}

function matchesCauseChain(error: unknown, matches: (candidate: unknown) => boolean): boolean {
  let current: unknown = error
  for (let depth = 0; depth < CAUSE_CHAIN_LIMIT; depth += 1) {
    if (matches(current)) return true
    if (typeof current !== 'object' || current === null || !('cause' in current)) return false
    current = (current as { cause?: unknown }).cause
  }
  return false
}

function isBusyError(error: unknown): boolean {
  return hasErrcode(error, SQLITE_BUSY_ERRCODE)
}

function hasErrcode(error: unknown, errcode: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'errcode' in error &&
    (error as { errcode?: unknown }).errcode === errcode
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

    // Pre-create the file at the right mode before DatabaseSync touches it:
    // the constructor creates the file at the default mode (644 under a
    // permissive umask) and the chmod below only tightens it afterwards,
    // leaving a TOCTOU window where the file briefly exists world-readable.
    // Creating it here first means it never exists at the wrong mode.
    const fh = await open(filePath, 'a', JOURNAL_FILE_MODE)
    await fh.close()

    // The constructor and PRAGMAs are synchronous by design of node:sqlite;
    // only the fs setup above has an async form.
    db = new sqlite.DatabaseSync(filePath)
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

/**
 * Copies the database behind `handle` to `destPath` with SQLite's online
 * backup and resolves with the number of pages transferred. The source stays
 * usable throughout; writes made through THIS handle land in the copy right
 * away, while writes from ANY OTHER connection restart the copy from the
 * beginning — batched commits are seconds apart, so a restart costs a retry,
 * not correctness, and the resulting file is always a consistent snapshot.
 *
 * The destination must not exist: an online backup that silently overwrote a
 * previous snapshot would destroy the operator's only fallback. Any failure,
 * including that refusal, rejects with `SqliteBackupError`.
 */
export async function backupSqlite(handle: SqliteHandle, destPath: string): Promise<number> {
  try {
    // Pre-create at 0600 for the same two reasons as openSqlite: no TOCTOU
    // window where the copy exists world-readable, and SQLite gives the
    // destination's -wal the destination file's own permissions. 'wx' makes
    // an existing destination an EEXIST failure instead of an overwrite.
    const fh = await open(destPath, 'wx', JOURNAL_FILE_MODE)
    await fh.close()

    return await sqlite.backup(handle.db, destPath)
  } catch (error: unknown) {
    throw new SqliteBackupError(handle.filePath, destPath, error)
  }
}

/**
 * Runs `PRAGMA integrity_check` and returns the problems it reported, empty
 * for a healthy database (SQLite answers a single `ok` row). Cost is O(size
 * of the database), so this belongs at the startup of long-lived entry
 * points, not on every command invocation.
 *
 * Damage bad enough to break the b-tree walk makes the check itself fail
 * (SQLITE_CORRUPT) instead of listing rows; that failure IS the finding, so
 * it is reported as a problem rather than thrown — a caller checking
 * integrity fail-closed must not have to handle corruption twice. A busy
 * database is not a corrupt one and still surfaces as an error.
 */
export function integrityProblemsOf(handle: SqliteHandle): readonly string[] {
  try {
    const rows = handle.db.prepare('PRAGMA integrity_check').all()
    const messages = rows.map((row) => String(Object.values(row)[0]))
    return messages.length === 1 && messages[0] === 'ok' ? [] : messages
  } catch (error: unknown) {
    if (isSqliteBusy(error)) throw error
    return [describeCause(error)]
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
