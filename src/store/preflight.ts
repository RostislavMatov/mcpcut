import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { GUIDE_URL } from '../brand.js'
import { journalDbPathFor, openJournalDbShared } from '../journal/db.js'
import { STATE_DB_FILE_NAME, openStateDbShared } from '../policy/store-backend.js'
import {
  integrityProblemsOf,
  isSqliteCorruption,
  SqliteOpenError,
  type SqliteHandle,
} from './sqlite.js'

/**
 * The startup gate of the four long-lived entry points (`serve`, `ui`,
 * `connect`, `wrap`): both databases of a journal directory are verified with
 * `PRAGMA integrity_check` before the process binds a port or spawns a
 * server. A plane that keeps running on a damaged journal writes records
 * nobody can later prove anything about, so this is fail-closed by design.
 *
 * Short-lived commands (`sessions`, `migrate`, `export`, …) deliberately do
 * NOT run it: the check costs O(database size) per invocation, and corruption
 * surfaces there through the stores' own classification instead.
 */

/** Minimal writable-stream shape the refusal is written to, so tests can inject a capture object. */
export interface PreflightWritable {
  write(chunk: string): unknown
}

/**
 * Raised when a database that exists on disk is damaged — in either of the
 * two shapes an operator meets, both of which mean the same thing to them
 * (restore from a backup), hence one error type rather than two.
 */
export class DatabaseIntegrityError extends Error {
  private constructor(message: string) {
    super(message)
    this.name = 'DatabaseIntegrityError'
  }

  /**
   * The file opened, but `PRAGMA integrity_check` reported damage. The first
   * reported problem is the message's payload: the check can answer with
   * hundreds of lines, and an operator acts on the first one (the remedy is
   * the same for all of them).
   */
  static fromIntegrityCheck(
    filePath: string,
    problems: readonly string[],
  ): DatabaseIntegrityError {
    return new DatabaseIntegrityError(
      `${basename(filePath)} failed PRAGMA integrity_check: ${problems[0] ?? 'unknown problem'}`,
    )
  }

  /**
   * The file did not open at all — a truncated or garbled header (a crash or
   * a full disk mid-write) makes `openSqlite`'s first PRAGMA fail. Damage
   * this bad never reaches `integrity_check`, so without this arm the
   * operator would get the raw low-level error and none of the guidance.
   */
  static fromUnopenable(filePath: string, cause: SqliteOpenError): DatabaseIntegrityError {
    return new DatabaseIntegrityError(`${basename(filePath)} cannot be opened: ${cause.message}`)
  }
}

/** The second line of the refusal; the first is the error's own message. */
const RESTORE_HINT = `Refusing to start. Restore the database from a backup (see "Backup & restore" in ${GUIDE_URL}/operations.md).\n`

/**
 * Both databases a journal directory can hold, each with the shared open its
 * own PRAGMA profile requires (`state.db` is `normal`, `journal.db` `full` —
 * opening either through the other's helper would apply the wrong durability).
 */
const DATABASES: ReadonlyArray<{
  readonly pathFor: (journalDir: string) => string
  readonly openShared: (dbPath: string) => Promise<SqliteHandle>
}> = [
  { pathFor: (journalDir) => join(journalDir, STATE_DB_FILE_NAME), openShared: openStateDbShared },
  { pathFor: journalDbPathFor, openShared: openJournalDbShared },
]

/**
 * Checks every database `journalDir` actually has. A missing one is skipped
 * rather than created: a fresh install has neither file, and a preflight that
 * created them would turn "nothing installed" into "empty install" — and
 * would do it from a code path whose whole job is to read.
 *
 * The handles are left open on purpose. They come from the per-process shared
 * caches, so closing one here would hand the store that opens it next a
 * closed connection; in a long-lived entry point the connection is needed
 * moments later anyway.
 */
export async function assertDatabasesHealthy(journalDir: string): Promise<void> {
  for (const database of DATABASES) {
    const dbPath = database.pathFor(journalDir)
    if (!(await isPresent(dbPath))) continue

    const problems = integrityProblemsOf(await openOrClassify(database.openShared, dbPath))
    if (problems.length > 0) {
      throw DatabaseIntegrityError.fromIntegrityCheck(dbPath, problems)
    }
  }
}

/**
 * Opens one database, turning a corruption-shaped open failure into the
 * classified refusal. The boundary is deliberate: only SQLITE_CORRUPT /
 * SQLITE_NOTADB (`isSqliteCorruption`) are damage. A permission problem, a
 * contended database, a vanished directory all fail the open too, and have
 * different remedies — telling their operator to restore from a backup would
 * be wrong, so they propagate unchanged.
 */
async function openOrClassify(
  openShared: (dbPath: string) => Promise<SqliteHandle>,
  dbPath: string,
): Promise<SqliteHandle> {
  try {
    return await openShared(dbPath)
  } catch (error: unknown) {
    if (error instanceof SqliteOpenError && isSqliteCorruption(error)) {
      throw DatabaseIntegrityError.fromUnopenable(dbPath, error)
    }
    throw error
  }
}

/**
 * `assertDatabasesHealthy` for a CLI entry point: `false` means the command
 * must return its startup-failure exit code, with the operator already told
 * why and what to do. Anything that is not a corruption finding (an
 * unreadable directory, a contended database) still propagates — those have
 * different remedies and must not be reported as damage.
 */
export async function preflightDatabases(
  journalDir: string,
  stderr: PreflightWritable,
): Promise<boolean> {
  try {
    await assertDatabasesHealthy(journalDir)
    return true
  } catch (error: unknown) {
    if (error instanceof DatabaseIntegrityError) {
      stderr.write(`${error.message}\n${RESTORE_HINT}`)
      return false
    }
    throw error
  }
}

/** True when the database file exists; mirrors `openJournalDbIfPresent`'s probe (`journal/db.ts`). */
async function isPresent(dbPath: string): Promise<boolean> {
  try {
    await stat(dbPath)
    return true
  } catch (error: unknown) {
    if (isMissing(error)) return false
    throw error
  }
}

function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
