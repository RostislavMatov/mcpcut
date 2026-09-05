import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { closeSync, constants as fsConstants, fchmodSync, openSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../config.js'
import { errnoCodeOf } from '../errno.js'
import { DATA_DIR_ENV_VAR } from '../setup/constants.js'
import { DAEMON_ENV_STRIPPED_VARS, SHARED_ACCESS_MASK, type ServiceName } from './constants.js'
import { serviceArgs } from './manager-args.js'
import type { ManagerContext } from './manager-types.js'
import { runDirFor } from './paths.js'

/**
 * Leaving a service behind that outlives the terminal (mcpcut phase 1, Task
 * 11; owner decision C2-revised).
 *
 * Three details carry that promise, and none of them is optional:
 *
 *   1. `detached: true` puts the child in its own session, so the terminal's
 *      SIGHUP never reaches it;
 *   2. its stdio is a FILE DESCRIPTOR, never `'pipe'` or `'inherit'`. A piped
 *      child dies with the parent's pipes, and an inherited one holds the
 *      terminal open — both defeat (1);
 *   3. `child.unref()` releases it from our event loop, so `mcpcut start` can
 *      return. It comes AFTER the `'exit'`/`'error'` subscriptions: those
 *      listeners are what the readiness loop reads, and an `'error'` event
 *      with no listener is thrown by Node rather than reported.
 *
 * Before any of that, `run/` and the log have to be ours alone (review SEC-H1):
 * whoever can write `run/` picks the pid a later `stop` signals, and a symlink
 * at the log path would have a long-lived daemon append to a file of someone
 * else's choosing.
 */

/** A spawned child plus the exit the readiness loop watches for. */
export interface DaemonHandle {
  readonly child: ChildProcess
  readonly pid: number | undefined
  /** The exit so far, polled by the readiness loop between probes. */
  readonly exit: () => ChildExit | undefined
  /** The same event as a promise, for the one caller that has no pid to poll on. */
  readonly settled: Promise<ChildExit>
}

export interface ChildExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: Error
}

/** A refusal that never spawned anything, carrying the line an operator reads. */
export interface PrepareFailure {
  readonly reason: string
}

/**
 * Makes `run/` and refuses if it is not this user's alone.
 *
 * `mkdir` creates it 0700, but it may already exist with looser bits — from an
 * older release, an operator's `chmod -R`, or a deliberately planted
 * directory. Anyone who can write it can plant a pid file, so this is a
 * refusal rather than a repair: silently tightening someone else's directory
 * would hide the fact that it was open in the first place.
 */
export async function prepareRunDir(dataDir: string): Promise<PrepareFailure | undefined> {
  const runDir = runDirFor(dataDir)
  await mkdir(runDir, { recursive: true, mode: JOURNAL_DIR_MODE })
  try {
    const stats = statSync(runDir)
    const mode = stats.mode & 0o777
    const uid = process.getuid?.()
    const foreign = uid !== undefined && stats.uid !== uid
    if ((mode & SHARED_ACCESS_MASK) !== 0 || foreign) {
      return { reason: runDirRefusal(runDir, mode) }
    }
    return undefined
  } catch (error: unknown) {
    return { reason: `cannot inspect the run directory ${runDir}: ${describeErrno(error)}` }
  }
}

/**
 * Action first, path last: the CLI renders this through `formatReadableField`,
 * whose length cap would otherwise trim the instruction off a long path.
 */
function runDirRefusal(runDir: string, mode: number): string {
  return (
    `run directory is not owner-only (mode 0${mode.toString(8)}) or not owned by this user; ` +
    `chmod 0700 it (and chown it) before starting: ${runDir}`
  )
}

/** An open log descriptor, or the reason there is none. */
export type LogOpen = { readonly kind: 'open'; readonly fd: number } | { readonly kind: 'failed'; readonly reason: string }

/**
 * Opens the daemon log for appending, refusing to follow a symlink.
 *
 * `O_NOFOLLOW` is the point: without it a symlink planted at `run/ui.log`
 * turns a daemon's diagnostics into an append to any file this user can write
 * (`~/.ssh/authorized_keys` is the classic). `fchmod` after the open tightens
 * a log an older release left 0666 — on the DESCRIPTOR, so nothing can swap
 * the path underneath between the two calls.
 */
export function openDaemonLog(logPath: string): LogOpen {
  let fd: number
  try {
    fd = openSync(
      logPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
      JOURNAL_FILE_MODE,
    )
  } catch (error: unknown) {
    return { kind: 'failed', reason: `cannot open the service log ${logPath}: ${describeErrno(error)}` }
  }
  try {
    fchmodSync(fd, JOURNAL_FILE_MODE)
  } catch (error: unknown) {
    closeSync(fd)
    return { kind: 'failed', reason: `cannot secure the service log ${logPath}: ${describeErrno(error)}` }
  }
  return { kind: 'open', fd }
}

/** Spawns the detached child and closes our copy of the log descriptor. */
export function spawnDaemon(ctx: ManagerContext, service: ServiceName, logFd: number): DaemonHandle {
  let child: ChildProcess
  try {
    child = ctx.spawn(ctx.execPath, serviceArgs(ctx, service), detachedSpawnOptions(logFd, ctx.env, ctx.dataDir))
  } finally {
    // The child holds its own duplicate of the descriptor; ours would leak
    // one per start for the lifetime of the CLI.
    closeSync(logFd)
  }
  return watchChild(child)
}

/** Subscribes to the child's end before releasing it from our event loop. */
function watchChild(child: ChildProcess): DaemonHandle {
  let exit: ChildExit | undefined
  let announce: (value: ChildExit) => void = () => undefined
  const settled = new Promise<ChildExit>((resolve) => {
    announce = resolve
  })
  const settle = (value: ChildExit): void => {
    exit = value
    announce(value)
  }
  child.on('exit', (code, signal) => settle({ code, signal }))
  child.on('error', (error: Error) => settle({ code: null, signal: null, error }))
  child.unref()
  return { child, pid: child.pid, exit: () => exit, settled }
}

/**
 * The spawn options, exported so the invariants above are testable on their
 * own rather than only through a running daemon.
 */
export function detachedSpawnOptions(logFd: number, env: NodeJS.ProcessEnv, cwd: string): SpawnOptions {
  return {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: daemonEnv(env, cwd),
    // `<cwd>/.mcp-journal/policy.json` is one of the policy sources
    // (ADR-0005); rooting the daemon at the data dir keeps that lookup inside
    // the install instead of wherever the operator's shell happened to be.
    cwd,
  }
}

/**
 * The environment a daemon inherits: everything except the credentials, and
 * with its data directory SET rather than passed through.
 *
 * Setting it is a structural bind (review TS-H3/SEC-M5). The manager writes
 * the child's pid file under `<dataDir>/run/`, so a child that resolved a
 * DIFFERENT install — because the operator's shell exported `MCP_JOURNAL_DIR`
 * at some other path — would serve one plane while the manager reported on
 * another. `MCPCUT_CONFIG` still passes through: it names the config file,
 * and the data directory taken from it is the one being overridden here
 * anyway.
 */
function daemonEnv(env: NodeJS.ProcessEnv, dataDir: string): NodeJS.ProcessEnv {
  const kept = Object.entries(env).filter(([name]) => !DAEMON_ENV_STRIPPED_VARS.includes(name))
  return { ...Object.fromEntries(kept), [DATA_DIR_ENV_VAR]: dataDir }
}

function describeErrno(error: unknown): string {
  const code = errnoCodeOf(error)
  const message = error instanceof Error ? error.message : String(error)
  return code === undefined ? message : `${code}: ${message}`
}
