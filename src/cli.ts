#!/usr/bin/env node
// First, on purpose: it silences the one `node:sqlite` experimental warning
// that used to head every command's stderr and every daemon log
// (`cli/warning-filter.ts`, user-journey smoke UX-7).
import './cli/warning-filter-install.js'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runAdminCommand } from './cli/admin-cmd.js'
import { runAgentCommand } from './cli/agent-cmd.js'
import { runGroupCommand } from './cli/group-cmd.js'
import { runApprovals } from './cli/approvals-cmd.js'
import { runBackupCommand } from './cli/backup-cmd.js'
import { runConnect } from './cli/connect-cmd.js'
import { runExportCommand } from './cli/export-cmd.js'
import { runJournalCommandGroup } from './cli/journal-cmds.js'
import { runKeygenCommand } from './cli/keygen-cmd.js'
import { runMigrateCommand } from './cli/migrate-cmd.js'
import { runPolicyShow, runPolicyValidate, type PolicyCliOptions } from './cli/policy-cmd.js'
import { runPolicySet } from './cli/policy-set-cmd.js'
import { runQuarantine } from './cli/quarantine-cmd.js'
import { runServe } from './cli/serve-cmd.js'
import { runServiceCommand } from './cli/service-cmd.js'
import { runSetupCommand } from './cli/setup-cmd.js'
import { isInteractiveTerminal, runTui } from './cli/tui-cmd.js'
import {
  runServerAdd,
  runServerList,
  runServerRemove,
  runServerShow,
  type ServerCliOptions,
} from './cli/server-cmd.js'
import { runServerRefresh } from './cli/server-status-cmd.js'
import { runUi } from './cli/ui-cmd.js'
import { runVault } from './cli/vault-cmd.js'
import { runPruneCommand } from './cli/prune-cmd.js'
import { runVerifyCommand } from './cli/verify-cmd.js'
import { runWrapCommand } from './cli/wrap-cmd.js'
import { USAGE } from './cli/usage.js'
import { JOURNAL_DIR_RESOLUTION } from './config.js'
import { describeDataDirProblem } from './setup/data-dir.js'
import type { CliIo, DispatchOptions } from './cli/dispatch-types.js'

/**
 * Thin argv-dispatch entry point. All real logic lives in tested modules
 * (cli/*-cmd.ts, proxy/, journal/) -- this file only routes argv to them.
 * Excluded from coverage by design.
 *
 * `dispatch()` is exported (rather than only a top-level `main()`) so tests
 * can drive full command routing without spawning a subprocess or touching
 * the real process stdio -- see `tests/cli/dispatch.test.ts`.
 */

/**
 * The io shapes and the seam bag live in the leaf `cli/dispatch-types.ts`, so
 * a command module can name them without importing this router. Re-exported
 * here because that is where callers and tests have always imported them from.
 */
export type { CliIo, CliWritable, DispatchOptions } from './cli/dispatch-types.js'

/**
 * The only commands that still run on an unusable install config (phase 1,
 * task 4): the two that explain the CLI. `setup` is exempt too — it is the
 * command that rewrites the broken file — but it never reaches this gate: it
 * is routed ahead of it. Everything else refuses; falling back to `$HOME`
 * would silently operate on a different plane than the operator configured.
 *
 * A bare interactive invocation is deliberately NOT exempt (phase 2, task
 * 15): a console opened over the wrong data directory is worse than a refusal
 * that names the file. A bare invocation outside a terminal never reaches the
 * gate either — it is the usage, and it is answered above.
 */
function isHelpFlag(command: string | undefined): boolean {
  return command === '--help' || command === '-h'
}

const DEFAULT_IO: CliIo = { stdout: process.stdout, stderr: process.stderr }

export async function dispatch(
  argv: readonly string[],
  io: CliIo = DEFAULT_IO,
  opts: DispatchOptions = {},
): Promise<number> {
  const command = argv[0]
  const rest = [...argv.slice(1)]

  // `setup` routes ahead of the broken-config gate below: it is the command
  // that rewrites the broken file, so the gate must never see it.
  if (command === 'setup') {
    return runSetupCommand(rest, io, {
      ...opts.setup,
      ...(opts.tui?.isTty !== undefined ? { isTty: opts.tui.isTty } : {}),
      ...(opts.tui?.terminal !== undefined ? { terminal: opts.tui.terminal } : {}),
      // The wizard is `runTui` with the wizard entry: the console module owns
      // the screen, this router owns the wiring, and `setup-cmd.ts` knows
      // neither — it holds a function it was handed.
      wizard: (args) => runTui([], io, { ...opts.tui, dispatch, entry: 'setup', setupArgs: args }),
    })
  }

  // A pipe, a script, CI: a bare invocation prints the usage, as it always
  // has — and ahead of the config gate, as it always has. Nothing that runs
  // unattended starts depending on a file it never needed.
  if (command === undefined && !isInteractiveTerminal(opts.tui)) {
    io.stdout.write(USAGE)
    return 0
  }

  const configProblem = describeDataDirProblem(opts.install ?? JOURNAL_DIR_RESOLUTION)
  if (configProblem !== undefined && !isHelpFlag(command)) {
    io.stderr.write(configProblem)
    return 1
  }

  if (isHelpFlag(command)) {
    io.stdout.write(USAGE)
    return 0
  }
  // What is left of a bare invocation is a terminal asking for the console.
  if (command === undefined) return runTui([], io, { ...opts.tui, dispatch, entry: 'bare' })
  if (command === 'tui') return runTui(rest, io, { ...opts.tui, dispatch, entry: 'explicit' })
  if (command === 'wrap') return runWrapCommand(rest, io, opts.wrap)
  if (command === 'connect') return runConnect(rest, io, opts.connect)
  if (command === 'serve') return runServe(rest, io, opts.serve)
  if (command === 'ui') return runUi(rest, io, opts.ui)
  if (command === 'start' || command === 'stop' || command === 'status' || command === 'logs') {
    return runServiceCommand(command, rest, io, opts.services)
  }
  if (command === 'admin') return runAdminCommand(rest, io, opts.admin)
  if (command === 'server') return runServerCommand(rest, io, opts.server)
  if (command === 'vault') return runVault(rest, io, opts.vault)
  if (command === 'agent') return runAgentCommand(rest, io, opts.agent)
  if (command === 'group') return runGroupCommand(rest, io, opts.group)
  if (command === 'migrate') return runMigrateCommand(rest, io, opts.migrate)
  if (command === 'export') return runExportCommand(rest, io, opts.export)
  if (command === 'backup') return runBackupCommand(rest, io, opts.backup)
  if (command === 'verify') return runVerifyCommand(rest, io, opts.verify)
  if (command === 'prune') return runPruneCommand(rest, io, opts.prune)
  if (command === 'keygen') return runKeygenCommand(rest, io, opts.keygen)
  if (command === 'sessions' || command === 'show') {
    return runJournalCommandGroup(command, rest, io, opts.journalDir)
  }
  if (command === 'policy') return runPolicyCommand(rest, io, opts.policy)
  if (command === 'quarantine') return runQuarantine(rest, io, opts.quarantine)
  if (command === 'approvals') return runApprovals(rest, io, opts.approvals)

  io.stderr.write(`Unknown command: ${command}\n\n${USAGE}`)
  return 1
}

/** `server add|list|show|remove|refresh` sub-router (same shape as runPolicyCommand). */
async function runServerCommand(
  args: string[],
  io: CliIo,
  opts: ServerCliOptions = {},
): Promise<number> {
  const [subcommand, ...rest] = args
  if (subcommand === 'add') return runServerAdd(rest, io, opts)
  if (subcommand === 'list') return runServerList(rest, io, opts)
  if (subcommand === 'show') return runServerShow(rest, io, opts)
  if (subcommand === 'remove') return runServerRemove(rest, io, opts)
  if (subcommand === 'refresh') return runServerRefresh(rest, io, opts)
  io.stderr.write(
    `${subcommand === undefined ? 'Missing server subcommand.' : `Unknown server subcommand: ${subcommand}`}\n\n${USAGE}`,
  )
  return 1
}

async function runPolicyCommand(
  policyArgs: readonly string[],
  io: CliIo,
  opts: PolicyCliOptions = {},
): Promise<number> {
  const [subcommand, ...rest] = policyArgs
  if (subcommand === 'validate') return runPolicyValidate(rest, io, opts)
  if (subcommand === 'show') return runPolicyShow(rest, io, opts)
  if (subcommand === 'set') return runPolicySet(rest, io, opts)
  io.stderr.write(
    `${subcommand === undefined ? 'Missing policy subcommand.' : `Unknown policy subcommand: ${subcommand}`}\n\n${USAGE}`,
  )
  return 1
}

async function main(): Promise<number> {
  return dispatch(process.argv.slice(2))
}

/**
 * Only runs `main()` when this file is executed directly (the `mcpcut`
 * binary), not when it is imported as a module -- `tests/cli/dispatch.test.ts`
 * imports `dispatch()` directly and must not trigger a second, argv-driven
 * dispatch as a side effect of that import.
 *
 * `argv[1]` is resolved through `realpathSync` because an npm-installed (or
 * `npm link`-ed) binary is a SYMLINK to this file: `import.meta.url` is the
 * real path, so comparing it against the raw symlink path never matches and
 * the CLI would silently exit 0 without dispatching.
 */
function isRunDirectly(): boolean {
  const argvPath = process.argv[1]
  if (argvPath === undefined) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(argvPath)).href
  } catch {
    return false
  }
}
const isMainModule = isRunDirectly()

if (isMainModule) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`${message}\n`)
      process.exitCode = 1
    })
}
