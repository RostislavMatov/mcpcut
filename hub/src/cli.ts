import { pathToFileURL } from 'node:url'
import { loadProvisionerLink } from './config.js'
import type { SweepSchedule, SweepScheduler } from './idle-sweeper.js'
import type { Orchestrator } from './orchestrator.js'
import { openOrchestrator, type OpenedOrchestrator } from './orchestrator-http.js'
import { OPERATOR_COMMANDS, runOperatorCommand } from './operator.js'
import { PROVISIONER_COMMANDS, PROVISIONER_USAGE, runProvisionerCommand } from './provisioner/cli.js'
import { runServe } from './serve.js'

/**
 * The hub's entry point (plan Task 5, H7): `node hub/dist/hub/src/cli.js
 * <command>`. `serve` runs the web process; the operator commands (`list`,
 * `block <login>`, `unblock <login>`, `delete <login>`, `purge-tombstones`,
 * `sweep [--dry-run]`)
 * run beside it in the host's shell against the same `HUB_DATA_DIR`.
 * `provision` runs the provisioner (plan `tenant-orchestrator`, Task 4) — a
 * separate process from the same image, the only one given the Docker
 * socket — and `provision-create|remove|status` drive it directly for a smoke.
 *
 * `runHubCli` takes every side effect as a parameter, so tests drive it
 * directly; the bottom of this file is the only place that touches the real
 * process (argv, signals, exit code).
 */

export interface HubCliIo {
  readonly env?: NodeJS.ProcessEnv
  readonly stdout?: (text: string) => void
  readonly stderr?: (text: string) => void
  readonly clock?: () => number
  /** Overrides the orchestrator the environment configures (tests). */
  readonly orchestrator?: Orchestrator
  /** `serve` and `provision` stop when this resolves; defaults to the first SIGINT/SIGTERM. */
  readonly shutdown?: Promise<void>
  /** Overrides when `serve` runs the idle sweeper (tests). */
  readonly sweepSchedule?: SweepSchedule
  /** Overrides what runs the idle sweeper on that schedule (tests drive sweeps by hand). */
  readonly sweepScheduler?: SweepScheduler
}

const USAGE =
  'usage: cli.js <command>\n' +
  '  serve                      run the hub (HUB_* environment)\n' +
  '  list                       accounts and the waitlist size\n' +
  '  block <github-login>       block an account; its sessions end, its install stops\n' +
  '  unblock <github-login>     lift a block\n' +
  '  delete <github-login>      delete an account (tombstone kept)\n' +
  '  purge-tombstones           drop delete tombstones past the cooldown\n' +
  '  sweep [--dry-run]          one idle sweep: stop at 60 unused days, remove at 90\n' +
  PROVISIONER_USAGE
const EXIT_FAILED = 1
const EXIT_USAGE = 2

export async function runHubCli(argv: readonly string[], io: HubCliIo = {}): Promise<number> {
  const env = io.env ?? process.env
  const stdout = io.stdout ?? ((text: string) => void process.stdout.write(text))
  const stderr = io.stderr ?? ((text: string) => void process.stderr.write(text))
  const [command = '', ...args] = argv
  if (command === 'serve') {
    const shutdown = io.shutdown ?? signalled()
    return runServe({
      env,
      stdout,
      stderr,
      shutdown,
      ...(io.orchestrator === undefined ? {} : { orchestrator: io.orchestrator }),
      ...(io.clock === undefined ? {} : { clock: io.clock }),
      ...(io.sweepSchedule === undefined ? {} : { sweepSchedule: io.sweepSchedule }),
      ...(io.sweepScheduler === undefined ? {} : { sweepScheduler: io.sweepScheduler }),
    })
  }
  if (PROVISIONER_COMMANDS.has(command)) {
    return runProvisionerCommand(command, args, { env, stdout, stderr, shutdown: () => io.shutdown ?? signalled() })
  }
  if (!OPERATOR_COMMANDS.has(command)) {
    stderr(USAGE)
    return EXIT_USAGE
  }
  const dataDir = env.HUB_DATA_DIR
  if (dataDir === undefined || dataDir === '') {
    stderr('hub: HUB_DATA_DIR is required\n')
    return EXIT_FAILED
  }
  const opened = operatorOrchestrator(env, io.orchestrator, stderr)
  if (opened === undefined) return EXIT_FAILED
  try {
    return await runOperatorCommand(command, args, dataDir, { stdout, stderr, orchestrator: opened.orchestrator, clock: io.clock ?? Date.now })
  } finally {
    opened.close()
  }
}

/** The operator's `delete` removes the install through the same provisioner `serve` uses. */
function operatorOrchestrator(
  env: NodeJS.ProcessEnv,
  given: Orchestrator | undefined,
  stderr: (text: string) => void,
): OpenedOrchestrator | undefined {
  if (given !== undefined) return { orchestrator: given, close: () => undefined }
  const link = loadProvisionerLink({ env })
  if (link.kind === 'invalid') {
    for (const problem of link.problems) stderr(`hub: ${problem}\n`)
    return undefined
  }
  return openOrchestrator(link.kind === 'ok' ? link.link : undefined)
}

function signalled(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve())
    process.once('SIGTERM', () => resolve())
  })
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  runHubCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      process.stderr.write(`hub: ${error instanceof Error ? `${error.name}: ${error.message}` : 'failed'}\n`)
      process.exitCode = EXIT_FAILED
    },
  )
}
