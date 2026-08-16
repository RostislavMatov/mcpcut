import { chmod, lstat, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { JOURNAL_DIR, JOURNAL_DIR_MODE } from '../config.js'
import { JOURNAL_DB_FILE_NAME, journalDbPathFor, openJournalDbShared } from '../journal/db.js'
import { STATE_DB_FILE_NAME, openStateDbShared } from '../policy/store-backend.js'
import { backupSqlite, SqliteBackupError, type SqliteHandle } from '../store/sqlite.js'

/**
 * `mcp-journal backup <destDir>` — an online SQLite backup of every database
 * the journal directory actually has (`state.db`, `journal.db`) into
 * `destDir`, one file per database, via `backupSqlite` (`store/sqlite.ts`).
 *
 * Uses the SHARED opens (`openStateDbShared`/`openJournalDbShared`) rather
 * than a private connection: a backup taken from inside a live `serve`
 * process shares that process's own connection, so its own mutations land in
 * the copy immediately instead of restarting it (see `backupSqlite`'s doc).
 *
 * `-wal`/`-shm` are never copied directly — SQLite's own online backup folds
 * them into the destination file, which is the whole point of this command
 * over "copy the directory and hope" (README "Backup & restore").
 */

/** Minimal writable-stream shape this command needs, so tests can inject capture objects. */
export interface BackupCliWritable {
  write(chunk: string): unknown
}

export interface BackupCliIo {
  readonly stdout: BackupCliWritable
  readonly stderr: BackupCliWritable
}

/** Test seam: journal directory override. */
export interface BackupCommandOptions {
  readonly journalDir?: string
}

const USAGE = 'Usage: mcp-journal backup <destDir>\n'

/** Every database a journal directory can hold, each with the shared open its own PRAGMA profile requires. */
const DATABASES: ReadonlyArray<{
  readonly basename: string
  readonly pathFor: (journalDir: string) => string
  readonly openShared: (dbPath: string) => Promise<SqliteHandle>
}> = [
  {
    basename: STATE_DB_FILE_NAME,
    pathFor: (journalDir) => join(journalDir, STATE_DB_FILE_NAME),
    openShared: openStateDbShared,
  },
  { basename: JOURNAL_DB_FILE_NAME, pathFor: journalDbPathFor, openShared: openJournalDbShared },
]

/**
 * Dispatches `backup <destDir>`. Creates `destDir` unconditionally (an
 * operator backing up an empty install still gets the directory) unless it is
 * a symlink, which is refused before anything is written, then backs
 * up whichever of `state.db`/`journal.db` actually exist — stat-probed,
 * never created by this command. An existing file at the destination is
 * refused by `backupSqlite` itself (`SqliteBackupError`), which this command
 * reports and exits 1 rather than silently overwriting a previous snapshot.
 */
export async function runBackupCommand(
  args: readonly string[],
  io: BackupCliIo,
  opts: BackupCommandOptions = {},
): Promise<number> {
  if (args.length !== 1) {
    io.stderr.write(`backup requires exactly one <destDir> argument (got: ${args.length})\n\n${USAGE}`)
    return 1
  }
  const destDir = args[0]!
  const journalDir = opts.journalDir ?? JOURNAL_DIR

  // Both `mkdir` and the `chmod` below follow symlinks, so a link pre-staged
  // at destDir would have this command tighten SOMEBODY ELSE'S directory to
  // 0700. Fail closed instead, matching `backupSqlite`'s 'wx' refusal to
  // touch a destination it did not create.
  if (await isSymlink(destDir)) {
    io.stderr.write(`backup: refusing to write into "${destDir}": it is a symlink\n`)
    return 1
  }

  await mkdir(destDir, { recursive: true, mode: JOURNAL_DIR_MODE })
  // mkdir's mode is masked by the process umask and ignored for a directory
  // that already exists — chmod unconditionally, like openSqlite does.
  await chmod(destDir, JOURNAL_DIR_MODE)

  let backedUpCount = 0
  try {
    for (const database of DATABASES) {
      const dbPath = database.pathFor(journalDir)
      if (!(await isPresent(dbPath))) {
        continue
      }
      const handle = await database.openShared(dbPath)
      const destPath = join(destDir, database.basename)
      await backupSqlite(handle, destPath)
      io.stdout.write(`backup: ${database.basename} -> ${destPath}\n`)
      backedUpCount += 1
    }
  } catch (error: unknown) {
    if (error instanceof SqliteBackupError) {
      io.stderr.write(`${error.message}\n`)
      return 1
    }
    throw error
  }

  if (backedUpCount === 0) {
    io.stderr.write('No databases to back up.\n')
    return 1
  }
  return 0
}

/** True when `path` exists and is a symlink; `lstat`, so the link itself is what is inspected. */
async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch (error: unknown) {
    if (isMissing(error)) return false // fresh path: mkdir will create it
    throw error
  }
}

/** True when the database file exists; mirrors `openJournalDbIfPresent`'s probe. */
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
