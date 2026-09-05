import type { Stats } from 'node:fs'
import { open, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runPolicyValidate } from '../cli/policy-cmd.js'
import { JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../config.js'
import { errnoCodeOf } from '../errno.js'
import { JOURNAL_DB_FILE_NAME } from '../journal/db.js'
import { POLICY_FILE_NAME } from '../policy/constants.js'
import { STATE_DB_FILE_NAME } from '../policy/store-backend.js'
import { RUN_DIR_NAME } from '../services/constants.js'
import { assertDatabasesHealthy, DatabaseIntegrityError } from '../store/preflight.js'
import { captureIo } from './capture-io.js'
import {
  CHECK_LEVEL_COLUMN,
  CHECK_LINE_PREFIX,
  CHECK_NAME_COLUMN,
  GROUP_AND_OTHER_PERMISSION_BITS,
  PERMISSION_BITS_MASK,
  WRITE_PROBE_FILE_NAME,
} from './constants.js'

/**
 * The `setup` preflight (phase 1, task 13): everything about the host that
 * must be true before a config is written and the services are started.
 *
 * Each check is a pure-ish function returning one `CheckResult` rather than
 * printing: `setup --yes` renders the block, and phase 2's wizard will render
 * the same answers differently. The shape mirrors `preflightDatabases`
 * (`src/store/preflight.ts`) — a verdict plus the sentence an operator acts
 * on — with `warn` added, because two of these findings (a loose directory
 * mode, a bind reachable from the network) are conditions an operator may
 * legitimately accept and must still be told about.
 *
 * `fail` is the only level `setup` refuses on. `warn` is printed and the run
 * continues: the non-interactive path has no dialog to confirm through, so a
 * warning that stopped the run would leave `--yes` unable to complete a
 * deliberate public bind at all (plan Risks table).
 */

/** How a check came out. Only `fail` stops `setup`; `warn` is printed and accepted. */
export type CheckLevel = 'ok' | 'warn' | 'fail'

/** One line of the preflight report: what was checked, how it went, and why. */
export interface CheckResult {
  readonly name: string
  readonly level: CheckLevel
  readonly detail: string
}

const DATA_DIR_CHECK = 'data dir'
const RUN_DIR_CHECK = 'run dir'
const DATABASES_CHECK = 'databases'
const POLICY_CHECK = 'policy'

const NO_RUN_DIR_DETAIL = 'not yet (created on first start)'
const NO_DATABASES_DETAIL = 'none yet (created on first start)'
const NO_POLICY_DETAIL = 'no policy.json (journaling-only)'

/**
 * Prepares the data directory and reports what it found: created 0700, or
 * already there with a looser mode, or unusable.
 *
 * The mode is a `warn`, not a `fail`. `0755` on the data directory means any
 * account on the host can list the journal and the vault file — worth saying
 * loudly — but it is also what an operator gets from an existing directory
 * they created by hand, and refusing to proceed would leave them no path
 * through `setup --yes` at all.
 */
export async function checkDataDir(dir: string): Promise<CheckResult> {
  const prepared = await prepareDataDir(dir)
  if (!prepared.ok) {
    return { name: DATA_DIR_CHECK, level: 'fail', detail: prepared.detail }
  }

  if (prepared.mode === JOURNAL_DIR_MODE) {
    return { name: DATA_DIR_CHECK, level: 'ok', detail: `${dir} (${formatMode(prepared.mode)})` }
  }
  return {
    name: DATA_DIR_CHECK,
    level: 'warn',
    detail: `${dir} is ${formatMode(prepared.mode)}, not ${formatMode(JOURNAL_DIR_MODE)}: other accounts on this host can read the journal`,
  }
}

type DataDirInspection =
  | { readonly ok: true; readonly mode: number }
  | { readonly ok: false; readonly detail: string }

/** Creates the directory, proves it is writable, and reads back the mode it ended up with. */
async function prepareDataDir(dir: string): Promise<DataDirInspection> {
  try {
    await mkdir(dir, { recursive: true, mode: JOURNAL_DIR_MODE })
    await proveWritable(dir)
    return { ok: true, mode: (await stat(dir)).mode & PERMISSION_BITS_MASK }
  } catch (error: unknown) {
    // `mkdir` with `recursive` never reports an existing directory, so EEXIST
    // can only be the probe name — a fault worth its own sentence.
    if (errnoCodeOf(error) === 'EEXIST') {
      return { ok: false, detail: leftoverProbeDetail(join(dir, WRITE_PROBE_FILE_NAME)) }
    }
    return { ok: false, detail: describeErrno(error) }
  }
}

/**
 * Creates and removes `WRITE_PROBE_FILE_NAME`.
 *
 * `open(..., 'wx')`, not `writeFile`: a plain write follows a symlink and
 * truncates whatever it points at, so a probe name planted in the data
 * directory would turn this check into a delete of somebody else's file. The
 * exclusive mode refuses an existing name instead, symlink included.
 *
 * The removal is deliberately NOT in a `finally`: a failed create leaves
 * nothing to clean, and a failed removal is itself a finding (a directory this
 * uid can add to but not unlink from breaks every atomic write the plane
 * makes) that must not be swallowed while masking the original error.
 */
async function proveWritable(dir: string): Promise<void> {
  const probePath = join(dir, WRITE_PROBE_FILE_NAME)
  const handle = await open(probePath, 'wx', JOURNAL_FILE_MODE)
  await handle.close()
  await rm(probePath, { force: true })
}

/** What an operator does about a probe name that is already taken. */
function leftoverProbeDetail(probePath: string): string {
  return (
    `${probePath} already exists: remove it and rerun ` +
    '(an interrupted run left it, or it was planted to make this check write through a symlink)'
  )
}

/**
 * `<data dir>/run` holds the pid files and the daemon logs, and the manager
 * refuses to start a service unless that directory is owner-only and owned by
 * this account. `setup` reports the same condition first: an operator whose
 * `run/` is group-readable should learn it from the preflight, not from a
 * start that refuses minutes later.
 *
 * A missing `run/` is the normal case for an install that has never started
 * anything, and the manager creates it 0700 itself.
 */
export async function checkRunDir(
  dir: string,
  currentUid: () => number | undefined = defaultUid,
): Promise<CheckResult> {
  const runDir = join(dir, RUN_DIR_NAME)
  const stats = await statIfPresent(runDir)
  if (stats === undefined) {
    return { name: RUN_DIR_CHECK, level: 'ok', detail: NO_RUN_DIR_DETAIL }
  }

  const mode = stats.mode & PERMISSION_BITS_MASK
  if ((mode & GROUP_AND_OTHER_PERMISSION_BITS) !== 0) {
    return {
      name: RUN_DIR_CHECK,
      level: 'fail',
      detail: `${runDir} is ${formatMode(mode)}: pid files and daemon logs must stay owner-only (${formatMode(JOURNAL_DIR_MODE)})`,
    }
  }

  const uid = currentUid()
  if (uid !== undefined && stats.uid !== uid) {
    return {
      name: RUN_DIR_CHECK,
      level: 'fail',
      detail: `${runDir} belongs to another account (uid ${stats.uid}, this process runs as ${uid})`,
    }
  }
  return { name: RUN_DIR_CHECK, level: 'ok', detail: `${runDir} (${formatMode(mode)})` }
}

/** `process.getuid` is absent on Windows, where the whole question is meaningless. */
function defaultUid(): number | undefined {
  return process.getuid?.()
}

/** `0700` — the way an operator reads a mode and the way `ls -l` explains it. */
function formatMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`
}

/**
 * Runs the startup gate of the long-lived entry points against the data
 * directory, so `setup` refuses on damage instead of writing a config that
 * points every future command at a database it will not open.
 *
 * A directory with no database is the normal case for a fresh install and is
 * reported as such: `assertDatabasesHealthy` skips a missing file rather than
 * creating it, which is exactly the behaviour a preflight needs.
 *
 * Anything that is not a corruption finding (an unreadable directory, a
 * database another process holds) propagates, as it does in
 * `preflightDatabases`: those have different remedies and must not be
 * reported to an operator as damage.
 */
export async function checkDatabases(dir: string): Promise<CheckResult> {
  const present = await presentDatabases(dir)
  if (present.length === 0) {
    return { name: DATABASES_CHECK, level: 'ok', detail: NO_DATABASES_DETAIL }
  }

  try {
    await assertDatabasesHealthy(dir)
  } catch (error: unknown) {
    if (error instanceof DatabaseIntegrityError) {
      return { name: DATABASES_CHECK, level: 'fail', detail: error.message }
    }
    throw error
  }
  return {
    name: DATABASES_CHECK,
    level: 'ok',
    detail: `${present.join(', ')} pass PRAGMA integrity_check`,
  }
}

/** Which of the two databases the directory actually holds, in the order they are checked. */
async function presentDatabases(dir: string): Promise<readonly string[]> {
  const names = [STATE_DB_FILE_NAME, JOURNAL_DB_FILE_NAME]
  const found = await Promise.all(
    names.map(async (name) => ((await isPresent(join(dir, name))) ? name : undefined)),
  )
  return found.filter((name): name is string => name !== undefined)
}

/**
 * Validates `<dir>/policy.json` through the same command an operator would
 * run (`policy validate <path>`), rather than a second copy of the loading
 * rules: a preflight that accepted a document the real loader rejects would
 * be worse than no preflight.
 *
 * Only the home-level file is checked, and by explicit path. The other three
 * policy sources (`--policy`, `$MCP_JOURNAL_POLICY`, the project-level file)
 * belong to a process's invocation, not to the install `setup` is describing.
 */
export async function checkPolicy(dir: string): Promise<CheckResult> {
  const path = join(dir, POLICY_FILE_NAME)
  if (!(await isPresent(path))) {
    return { name: POLICY_CHECK, level: 'ok', detail: NO_POLICY_DETAIL }
  }

  const captured = captureIo()
  const exitCode = await runPolicyValidate([path], captured.io, { journalDir: dir })
  if (exitCode === 0) {
    return { name: POLICY_CHECK, level: 'ok', detail: `${path} valid` }
  }
  return { name: POLICY_CHECK, level: 'fail', detail: captured.problems() }
}

/** One report row: `check  data dir     ok   /var/lib/mcpcut (0700)`. No trailing newline — the caller writes lines. */
export function formatCheck(result: CheckResult): string {
  return `${CHECK_LINE_PREFIX}${result.name.padEnd(CHECK_NAME_COLUMN)} ${result.level.padEnd(CHECK_LEVEL_COLUMN)} ${result.detail}`
}

/** True when the path exists; mirrors the private `isPresent` of `src/store/preflight.ts`. */
async function isPresent(path: string): Promise<boolean> {
  return (await statIfPresent(path)) !== undefined
}

/**
 * The path's `Stats`, or `undefined` when nothing is there. Only "not there"
 * is an answer; every other errno (EACCES on a parent, say) is a fault the
 * caller must not mistake for an absent file.
 */
async function statIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  } catch (error: unknown) {
    const code = errnoCodeOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}

/**
 * `<code>: <message>` for an operator, without repeating the code when the
 * platform already put it there — every `fs` errno message opens with
 * `ENOTDIR: ...`, and `ENOTDIR: ENOTDIR: ...` reads like a bug in the check.
 * Paths are kept (they are the actionable half); nothing from inside a file
 * is ever echoed, the rule `src/setup/load.ts` states for the same reason.
 */
export function describeErrno(error: unknown): string {
  const code = errnoCodeOf(error)
  const message = error instanceof Error ? error.message : String(error)
  if (code === undefined || message.startsWith(`${code}:`)) return message
  return `${code}: ${message}`
}

