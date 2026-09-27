import { pathToFileURL } from 'node:url'
import { unavailableOrchestrator, type Orchestrator } from './orchestrator.js'
import { OPERATOR_COMMANDS, runOperatorCommand } from './operator.js'
import { runServe } from './serve.js'

/**
 * The hub's entry point (plan Task 5, H7): `node hub/dist/hub/src/cli.js
 * <command>`. `serve` runs the web process; the operator commands (`list`,
 * `block <login>`, `unblock <login>`, `delete <login>`, `purge-tombstones`)
 * run beside it in the host's shell against the same `HUB_DATA_DIR`.
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
  /** Phase 3 passes its orchestrator here; until then nobody gets an install (H5). */
  readonly orchestrator?: Orchestrator
  /** `serve` stops when this resolves; defaults to the first SIGINT/SIGTERM. */
  readonly shutdown?: Promise<void>
}

const USAGE =
  'usage: cli.js <command>\n' +
  '  serve                      run the hub (HUB_* environment)\n' +
  '  list                       accounts and the waitlist size\n' +
  '  block <github-login>       block an account; its sessions end\n' +
  '  unblock <github-login>     lift a block\n' +
  '  delete <github-login>      delete an account (tombstone kept)\n' +
  '  purge-tombstones           drop delete tombstones past the cooldown\n'
const EXIT_FAILED = 1
const EXIT_USAGE = 2

export async function runHubCli(argv: readonly string[], io: HubCliIo = {}): Promise<number> {
  const env = io.env ?? process.env
  const stdout = io.stdout ?? ((text: string) => void process.stdout.write(text))
  const stderr = io.stderr ?? ((text: string) => void process.stderr.write(text))
  const orchestrator = io.orchestrator ?? unavailableOrchestrator
  const [command = '', ...args] = argv
  if (command === 'serve') {
    const shutdown = io.shutdown ?? signalled()
    return runServe({ env, stdout, stderr, orchestrator, shutdown, ...(io.clock === undefined ? {} : { clock: io.clock }) })
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
  return runOperatorCommand(command, args, dataDir, { stdout, stderr, orchestrator, clock: io.clock ?? Date.now })
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
