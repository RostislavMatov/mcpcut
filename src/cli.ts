#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runAdminCommand, type AdminCliOptions } from './cli/admin-cmd.js'
import { runAgentCommand, type AgentCliOptions } from './cli/agent-cmd.js'
import { runApprovals, type ApprovalsCliOptions } from './cli/approvals-cmd.js'
import { runConnect, type ConnectDeps } from './cli/connect-cmd.js'
import { runJournalCommandGroup } from './cli/journal-cmds.js'
import { runPolicyShow, runPolicyValidate, type PolicyCliOptions } from './cli/policy-cmd.js'
import { runQuarantine, type RunQuarantineOptions } from './cli/quarantine-cmd.js'
import { runServe, type ServeCommandOptions } from './cli/serve-cmd.js'
import {
  runServerAdd,
  runServerList,
  runServerRemove,
  runServerShow,
  type ServerCliOptions,
} from './cli/server-cmd.js'
import { runUi, type UiCommandOptions } from './cli/ui-cmd.js'
import { runVault, type VaultCmdDeps } from './cli/vault-cmd.js'
import { runWrapCommand, type WrapCommandOptions } from './cli/wrap-cmd.js'
import { USAGE } from './cli/usage.js'

/**
 * Thin argv-dispatch entry point. All real logic lives in tested modules
 * (cli/*-cmd.ts, proxy/, journal/) -- this file only routes argv to them.
 * Excluded from coverage by design.
 *
 * `dispatch()` is exported (rather than only a top-level `main()`) so tests
 * can drive full command routing without spawning a subprocess or touching
 * the real process stdio -- see `tests/cli/dispatch.test.ts`.
 */

/** Minimal writable-stream shape the dispatcher and its subcommands need. */
export interface CliWritable {
  write(chunk: string): unknown
}

export interface CliIo {
  readonly stdout: CliWritable
  readonly stderr: CliWritable
}

/** Test-only seams for each subcommand, so `tests/cli/dispatch.test.ts` can isolate every command from real disk state. */
export interface DispatchOptions {
  /** Journal directory override for `sessions`/`show`. Defaults to JOURNAL_DIR. */
  readonly journalDir?: string
  readonly wrap?: WrapCommandOptions
  readonly policy?: PolicyCliOptions
  readonly quarantine?: RunQuarantineOptions
  readonly approvals?: ApprovalsCliOptions
  readonly server?: ServerCliOptions
  readonly vault?: VaultCmdDeps
  readonly agent?: AgentCliOptions
  readonly connect?: ConnectDeps
  readonly serve?: ServeCommandOptions
  readonly ui?: UiCommandOptions
  readonly admin?: AdminCliOptions
}

const DEFAULT_IO: CliIo = { stdout: process.stdout, stderr: process.stderr }

export async function dispatch(
  argv: readonly string[],
  io: CliIo = DEFAULT_IO,
  opts: DispatchOptions = {},
): Promise<number> {
  const command = argv[0]
  const rest = [...argv.slice(1)]

  if (command === undefined || command === '--help' || command === '-h') {
    io.stdout.write(USAGE)
    return 0
  }
  if (command === 'wrap') return runWrapCommand(rest, io, opts.wrap)
  if (command === 'connect') return runConnect(rest, io, opts.connect)
  if (command === 'serve') return runServe(rest, io, opts.serve)
  if (command === 'ui') return runUi(rest, io, opts.ui)
  if (command === 'admin') return runAdminCommand(rest, io, opts.admin)
  if (command === 'server') return runServerCommand(rest, io, opts.server)
  if (command === 'vault') return runVault(rest, io, opts.vault)
  if (command === 'agent') return runAgentCommand(rest, io, opts.agent)
  if (command === 'sessions' || command === 'show') {
    return runJournalCommandGroup(command, rest, io, opts.journalDir, USAGE)
  }
  if (command === 'policy') return runPolicyCommand(rest, io, opts.policy)
  if (command === 'quarantine') return runQuarantine(rest, io, opts.quarantine)
  if (command === 'approvals') return runApprovals(rest, io, opts.approvals)

  io.stderr.write(`Unknown command: ${command}\n\n${USAGE}`)
  return 1
}

/** `server add|list|show|remove` sub-router (same shape as runPolicyCommand). */
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
  io.stderr.write(
    `${subcommand === undefined ? 'Missing policy subcommand.' : `Unknown policy subcommand: ${subcommand}`}\n\n${USAGE}`,
  )
  return 1
}

async function main(): Promise<number> {
  return dispatch(process.argv.slice(2))
}

/**
 * Only runs `main()` when this file is executed directly (the `mcp-journal`
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
