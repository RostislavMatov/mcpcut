import { chmod, lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { JOURNAL_DIR_MODE } from '../config.js'

/**
 * Where `mcp-journal export --report` is allowed to write (M5 wave 5, review
 * round). Split out of `report-cmd.ts` because "is this directory safe to put
 * evidence in" is a self-contained question with three independent answers to
 * get right, and because that file is at the project's 400-line cap.
 *
 * The three findings this module closes, all confirmed by the wave-5 review:
 * - a PRE-EXISTING directory kept its own mode. `mkdir`'s `mode` applies only
 *   to directories it actually creates, so `--out` into a `0777` directory
 *   stayed `0777` while README stated flatly that the export directory is
 *   created at 0700 -- another local user could list the export and replace
 *   entries before handoff;
 * - a SYMLINKED `--out` was followed silently, so the files landed somewhere
 *   other than where the operator was told they went;
 * - `--out` at a FILE (ENOTDIR) or an unreadable directory (EACCES) threw out
 *   of the command's own error path into the process-level handler.
 *
 * The emptiness refusal is unchanged in substance: a half-overwritten
 * evidence export is worse than no export.
 */

export interface PreparedOutDir {
  /** The path to write into, exactly as given. */
  readonly path: string
  /** The same location with every symlink resolved -- what the operator is told. */
  readonly realPath: string
  /**
   * The topmost directory `mkdir` actually created, absent when the directory
   * already existed. This is what a failed export may delete: removing a
   * directory the operator had already made (and may have put something else
   * in) is not this command's to do.
   */
  readonly createdRoot?: string
  /** Set iff the directory must not be written to; the caller prints it and exits. */
  readonly refusal?: string
}

/**
 * Validates `outDir`, then creates it at 0700 (and tightens it to 0700 if it
 * already existed). Returns a refusal instead of throwing for every condition
 * an operator can fix by passing a different `--out`; genuine I/O failures
 * (EACCES and friends) still throw, into the command's own catch.
 */
export async function prepareReportOutDir(outDir: string): Promise<PreparedOutDir> {
  const refusal = await refusalFor(outDir)
  if (refusal !== null) return { path: outDir, realPath: outDir, refusal }

  const createdRoot = await mkdir(outDir, { recursive: true, mode: JOURNAL_DIR_MODE })
  // `mkdir`'s mode is masked by the umask and IGNORED for a directory that
  // already exists, so it is not on its own a guarantee of anything --
  // `store/sqlite.ts` chmods unconditionally for exactly this reason and this
  // does the same. Correcting rather than refusing is deliberate: `mkdir out`
  // under a default umask leaves 0755, which is the common case, and an
  // operator who pre-made the directory should get a tightened export, not a
  // lecture. It happens before the first byte is written, so no artifact ever
  // exists at a wider mode.
  await chmod(outDir, JOURNAL_DIR_MODE)

  return {
    path: outDir,
    realPath: await realpath(outDir),
    ...(createdRoot === undefined ? {} : { createdRoot }),
  }
}

/** `null` when `outDir` is safe to write into (absent, or an empty real directory). */
async function refusalFor(outDir: string): Promise<string | null> {
  const existing = await lstatOrNull(outDir)
  if (existing === null) return null

  if (existing.isSymbolicLink()) {
    // Not followed, and not "resolved and used": the operator was told where
    // the evidence would go, and a link silently redirects it -- possibly onto
    // a path another user controls.
    return (
      `Refusing to write into "${outDir}": it is a symbolic link. An export directory is ` +
      'handed to an auditor, so it must be the place the operator named, not wherever a link ' +
      'points. Pass the real path with --out.\n'
    )
  }
  if (!existing.isDirectory()) {
    return (
      `Refusing to write into "${outDir}": it exists and is not a directory. ` +
      'Pass an empty or new directory with --out.\n'
    )
  }

  const entries = await readdir(outDir)
  if (entries.length === 0) return null
  return (
    `Refusing to write into "${outDir}": the directory already exists and is not empty. ` +
    'A half-overwritten evidence export is worse than no export -- pass an empty or new ' +
    'directory with --out.\n'
  )
}

/** `null` for "nothing is there"; every other failure (EACCES, ELOOP, ...) is a real error and propagates. */
async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error: unknown) {
    if (isEnoent(error)) return null
    throw error
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
