import { errnoCodeOf } from '../errno.js'
import { formatReadableField } from '../journal/format.js'
import { type ServiceName } from '../services/constants.js'
import {
  formatExposureWarnings,
  formatStartResult,
  formatStatusTable,
  formatStopResult,
  statusJson,
} from '../services/format.js'
import {
  createServiceManager,
  type ServiceManager,
  type ServiceManagerDeps,
  type ServiceStatus,
  type StartResult,
  type StopResult,
} from '../services/manager.js'
import { CLI_NAME } from '../setup/constants.js'
import { resolveDataDir } from '../setup/data-dir.js'
import { loadInstallConfigSync, type InstallConfigLoad } from '../setup/load.js'
import { parseServiceArgs, type OkServiceArgs } from './service-cmd-args.js'

/**
 * `mcpcut start|stop|status|logs` (mcpcut phase 1, Task 12) — the four
 * commands an operator drives the service manager with.
 *
 * This module owns argv, ordering, streams and exit codes, and nothing else:
 * the manager decides what a start or a stop DOES (`src/services/manager.ts`)
 * and `src/services/format.ts` decides what it looks like. The one judgement
 * made here is what each exit code means, and it is made per verb — `stop`
 * is happy about a service that was already down, while `status` is not.
 *
 * Every verb needs an install config, because that file is where a service's
 * data directory and bind address come from. Without one they refuse and name
 * `mcpcut setup --yes` rather than falling back to `$HOME`: starting a daemon
 * in a plane the operator did not configure is worse than not starting one.
 */

/** The four verbs this module answers for; the dispatcher routes each by name. */
export type ServiceCommandName = 'start' | 'stop' | 'status' | 'logs'

/** Minimal writable-stream shape these commands need (same shape as `CliIo`). */
export interface ServiceCliWritable {
  write(chunk: string): unknown
}

export interface ServiceCliIo {
  readonly stdout: ServiceCliWritable
  readonly stderr: ServiceCliWritable
}

/** Test seams: an isolated install, an isolated manager, an isolated environment. */
export interface ServiceCliOptions {
  /** Data directory override, ranked above the config's `dataDir`. */
  readonly journalDir?: string
  /** Pre-read install config. Defaults to reading it here, once. */
  readonly install?: InstallConfigLoad
  /** A ready-made manager; the default is built from the resolved config. */
  readonly manager?: ServiceManager
  /** Environment for the config lookup and for the daemons. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Overrides handed to `createServiceManager` (the CLI path, the timeouts). */
  readonly managerDeps?: Partial<ServiceManagerDeps>
}

const EXIT_OK = 0
const EXIT_FAILURE = 1

/** Completes "Refusing to ..." in each verb's own terms (`admin-token.ts` form). */
const REFUSED_ACTION: Record<ServiceCommandName, string> = {
  start: 'start services',
  stop: 'stop services',
  status: 'report on services',
  logs: 'read service logs',
}

const DEFAULT_IO: ServiceCliIo = { stdout: process.stdout, stderr: process.stderr }

export async function runServiceCommand(
  command: ServiceCommandName,
  args: readonly string[],
  io: ServiceCliIo = DEFAULT_IO,
  opts: ServiceCliOptions = {},
): Promise<number> {
  const parsed = parseServiceArgs(command, args)
  if (parsed.kind === 'error') {
    io.stderr.write(parsed.message)
    return EXIT_FAILURE
  }

  const install =
    opts.install ?? loadInstallConfigSync(opts.env !== undefined ? { env: opts.env } : {})
  if (install.kind !== 'ok') {
    io.stderr.write(missingConfigMessage(command, install))
    return EXIT_FAILURE
  }

  try {
    const manager = opts.manager ?? managerFor(install, opts)
    return await runVerb(command, parsed, manager, io)
  } catch (error: unknown) {
    // A failure to reach the run directory (EACCES on the data dir, ENOSPC
    // writing a pid file) is an operator's situation too. Anything else is
    // this plane being wrong about itself and keeps its stack trace
    // (`keygen-cmd.ts` form).
    if (!(error instanceof Error) || errnoCodeOf(error) === undefined) throw error
    io.stderr.write(`${CLI_NAME} ${command}: ${error.message}\n`)
    return EXIT_FAILURE
  }
}

/**
 * Builds the manager this install describes: `MCPCUT_DATA_DIR` above
 * `config.dataDir` for the directory, and `config.supervisor` — alone — for
 * who owns the processes.
 *
 * Reading `config.dataDir` alone was the TS-H3 / SEC-M5 fault: with the
 * variable exported, `setup` prepared one directory while these commands
 * started daemons in another — and the `ui` that came up in the unprepared one
 * would bootstrap a second owner and leave its token file in the wrong plane.
 *
 * The supervisor has no such override, and deliberately so (owner decision
 * 2026-09-05, ADR-0012 §9): who runs the services is answered once, by a
 * human, at install time. `start` runs unattended and must not ask.
 */
function managerFor(
  install: Extract<InstallConfigLoad, { kind: 'ok' }>,
  opts: ServiceCliOptions,
): ServiceManager {
  const env = opts.env ?? process.env
  return createServiceManager({
    dataDir: opts.journalDir ?? resolveDataDir({ env, load: install }).dataDir,
    config: install.config,
    env,
    ...opts.managerDeps,
  })
}

async function runVerb(
  command: ServiceCommandName,
  parsed: OkServiceArgs,
  manager: ServiceManager,
  io: ServiceCliIo,
): Promise<number> {
  if (command === 'start') return runStart(parsed.services, manager, io)
  if (command === 'stop') return runStop(parsed.services, manager, io)
  if (command === 'status') return runStatus(parsed, manager, io)
  return runLogs(parsed, manager, io)
}

/**
 * Exit 0 means "nothing left for you to do": a service that was already
 * running, and one this install hands to another supervisor, are both that.
 * A failed start and an unsupported platform are not.
 */
async function runStart(
  services: readonly ServiceName[],
  manager: ServiceManager,
  io: ServiceCliIo,
): Promise<number> {
  const results: StartResult[] = []
  for (const service of services) {
    // Sequential on purpose: the lines an operator reads must match the order
    // the services were actually asked in.
    const result = await manager.start(service)
    io.stdout.write(formatStartResult(service, result))
    results.push(result)
  }
  return results.every(isStartSettled) ? EXIT_OK : EXIT_FAILURE
}

function isStartSettled(result: StartResult): boolean {
  return result.kind === 'started' || result.kind === 'already-running' || result.kind === 'external'
}

/**
 * A stop only fails when it could not even try (an unsupported platform):
 * "it was not running" and "somebody else runs it" are both the state the
 * operator asked for.
 */
async function runStop(
  services: readonly ServiceName[],
  manager: ServiceManager,
  io: ServiceCliIo,
): Promise<number> {
  const results: StopResult[] = []
  for (const service of services) {
    const result = await manager.stop(service)
    // A cleared stale pid file is not the outcome that was asked for; it is a
    // warning about state that was found, so it goes where warnings go.
    const stream = result.kind === 'stale-cleared' ? io.stderr : io.stdout
    stream.write(formatStopResult(service, result))
    results.push(result)
  }
  return results.every((result) => result.kind !== 'unsupported') ? EXIT_OK : EXIT_FAILURE
}

/**
 * Exit 0 only when every service is `running` — a pid that is alive AND a
 * port that answers. Anything else (stopped, stale, still starting, or run by
 * someone else) is something a health check must not read as fine.
 */
async function runStatus(
  parsed: OkServiceArgs,
  manager: ServiceManager,
  io: ServiceCliIo,
): Promise<number> {
  const statuses: ServiceStatus[] = []
  for (const service of parsed.services) {
    statuses.push(await manager.status(service))
  }
  io.stdout.write(parsed.json ? statusJson(statuses) : formatStatusTable(statuses))
  // A reachable bind is a warning, not a failure (Q31): it goes to stderr and
  // leaves the exit code alone. Not under `--json` — the field is already in
  // the document, and the console header reads `status --json` through a
  // capture, so that form stays machine-clean. The table form is what the
  // console runs on Home and Services, and there the warning DOES land in the
  // panel under `— stderr —`, on purpose: that is where the console shows it
  // (`tests/tui/output-status-exposure.test.ts`).
  if (!parsed.json) {
    const warnings = formatExposureWarnings(statuses)
    if (warnings !== '') io.stderr.write(warnings)
  }
  return statuses.every((status) => status.state === 'running') ? EXIT_OK : EXIT_FAILURE
}

/**
 * The tail, screened. These lines are the daemon's own words — which include
 * whatever an upstream MCP server made it print — and they land in a terminal
 * that acts on control sequences: echoed raw, a line carrying `ESC[2K` can
 * erase the lines above it, so the operator reads a tail somebody else wrote
 * (SEC-M6). `formatReadableField` is the same screen every other CLI surface
 * puts foreign text through.
 *
 * Exit 0 even for an empty tail — a service that has logged nothing yet is not
 * an error, and `status` is where the question "is it up" belongs.
 */
async function runLogs(
  parsed: OkServiceArgs,
  manager: ServiceManager,
  io: ServiceCliIo,
): Promise<number> {
  for (const service of parsed.services) {
    const tail = await manager.logs(service, parsed.lines)
    if (tail.length > 0) io.stdout.write(`${tail.map(formatReadableField).join('\n')}\n`)
  }
  return EXIT_OK
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * What each verb says when there is no usable install config.
 *
 * `status` is the exception that states the fact instead of refusing: it is
 * the command an operator (or a health check) runs to find out where things
 * stand, and "there is no install here" is an answer to that question. It
 * still exits 1 — nothing is running that this CLI knows about.
 */
function missingConfigMessage(
  command: ServiceCommandName,
  install: Exclude<InstallConfigLoad, { kind: 'ok' }>,
): string {
  if (install.kind === 'invalid') {
    const detail = install.problems.map((problem) => `  ${problem}`).join('\n')
    return (
      `Refusing to ${REFUSED_ACTION[command]}: install config ${install.path} is unusable:\n${detail}\n` +
      `Fix or remove it, then: ${CLI_NAME} setup --yes --force\n`
    )
  }
  if (command === 'status') return `status: no install config at ${install.path}\n`
  // Both ways to an install, in the order an operator meets them: the wizard a
  // bare `mcpcut` opens on a terminal, and the flags a script uses. `start`
  // itself stays non-interactive — it runs with nobody watching.
  return (
    `Refusing to ${REFUSED_ACTION[command]}: no install config at ${install.path}. ` +
    `Run: ${CLI_NAME} (interactive setup) or ${CLI_NAME} setup --yes [--data-dir <dir>]\n`
  )
}
