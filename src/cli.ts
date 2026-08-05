#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { runApprovals, type ApprovalsCliOptions } from './cli/approvals-cmd.js'
import { runPolicyShow, runPolicyValidate, type PolicyCliOptions } from './cli/policy-cmd.js'
import { formatRecordsJson, formatRecordsReadable, formatSessionsTable } from './cli/session-view.js'
import { runQuarantine, type RunQuarantineOptions } from './cli/quarantine-cmd.js'
import { runWrapCommand, type WrapCommandOptions } from './cli/wrap-cmd.js'
import {
  isValidJournalDirection,
  isValidJournalKind,
  JOURNAL_DIRECTIONS,
  JOURNAL_KINDS,
  listSessions,
  readSessionWithStats,
} from './journal/reader.js'

/**
 * Thin argv-dispatch entry point. All real logic lives in tested modules
 * (proxy/wrap.ts via cli/wrap-cmd.ts, journal/reader.ts, cli/*-cmd.ts) --
 * this file only parses argv, routes to them, and formats output. Excluded
 * from coverage by design.
 *
 * `dispatch()` is exported (rather than only a top-level `main()`) so tests
 * can drive full command routing without spawning a subprocess or touching
 * the real process stdio -- see `tests/cli/dispatch.test.ts`.
 */

const USAGE = `Usage:
  mcp-journal wrap [--server <name>] [--policy <path>] [--no-policy] [--fail-closed] -- <cmd> [args...]
                                         Run a wrapped MCP server, journaling all traffic
  mcp-journal sessions                  List journaled sessions
  mcp-journal show <sessionId> [--method X] [--direction Y] [--kind Z] [--json]
                                         Print one session's journal records
  mcp-journal policy validate [path]    Validate the resolved (or given) policy file
  mcp-journal policy show [--server <name>] [--json] [--policy <path>]
                                         Print the effective policy (defaults applied)
  mcp-journal quarantine list [--server <name>] [--json]
                                         List quarantined tools
  mcp-journal quarantine approve <server> <tool> | --all --server <name>
                                         Approve quarantined tool(s)
  mcp-journal quarantine reject <server> <tool>
                                         Reject (discard) a quarantined tool
  mcp-journal approvals list [--json]   List pending approval requests
  mcp-journal approvals approve <id> [--reason TEXT]
                                         Approve a pending request
  mcp-journal approvals deny <id> [--reason TEXT]
                                         Deny a pending request
  mcp-journal --help                    Show this message
`

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
}

const DEFAULT_IO: CliIo = { stdout: process.stdout, stderr: process.stderr }

export async function dispatch(
  argv: readonly string[],
  io: CliIo = DEFAULT_IO,
  opts: DispatchOptions = {},
): Promise<number> {
  const command = argv[0]

  if (command === undefined || command === '--help' || command === '-h') {
    io.stdout.write(USAGE)
    return 0
  }
  if (command === 'wrap') {
    return runWrapCommand(argv.slice(1), io, opts.wrap)
  }
  if (command === 'sessions') {
    return runSessionsCommand(io, opts.journalDir)
  }
  if (command === 'show') {
    return runShowCommand(argv.slice(1), io, opts.journalDir)
  }
  if (command === 'policy') {
    return runPolicyCommand(argv.slice(1), io, opts.policy)
  }
  if (command === 'quarantine') {
    return runQuarantine([...argv.slice(1)], io, opts.quarantine)
  }
  if (command === 'approvals') {
    return runApprovals([...argv.slice(1)], io, opts.approvals)
  }

  io.stderr.write(`Unknown command: ${command}\n\n${USAGE}`)
  return 1
}

async function runPolicyCommand(
  policyArgs: readonly string[],
  io: CliIo,
  opts: PolicyCliOptions = {},
): Promise<number> {
  const [subcommand, ...rest] = policyArgs
  if (subcommand === 'validate') {
    return runPolicyValidate(rest, io, opts)
  }
  if (subcommand === 'show') {
    return runPolicyShow(rest, io, opts)
  }
  io.stderr.write(
    `${subcommand === undefined ? 'Missing policy subcommand.' : `Unknown policy subcommand: ${subcommand}`}\n\n${USAGE}`,
  )
  return 1
}

async function runSessionsCommand(io: CliIo, journalDir: string | undefined): Promise<number> {
  const sessions = await listSessions(journalDir)
  io.stdout.write(sessions.length === 0 ? 'No sessions found.\n' : formatSessionsTable(sessions))
  return 0
}

/**
 * Parses `show <sessionId> [--method X] [--direction Y] [--json]` and prints
 * its records. Options are parsed from the *whole* argument list before the
 * positional sessionId is read, so `show --json 01ABC` cannot silently treat
 * `--json` as the session id.
 */
async function runShowCommand(
  showArgs: readonly string[],
  io: CliIo,
  journalDir: string | undefined,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...showArgs],
    options: {
      method: { type: 'string' },
      direction: { type: 'string' },
      kind: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  })

  const sessionId = positionals[0]
  if (sessionId === undefined) {
    io.stderr.write(`Missing <sessionId> in show command.\n\n${USAGE}`)
    return 1
  }

  const direction = values.direction
  if (direction !== undefined && !isValidJournalDirection(direction)) {
    io.stderr.write(
      `Invalid --direction "${direction}". Allowed values: ${JOURNAL_DIRECTIONS.join(', ')}\n\n${USAGE}`,
    )
    return 1
  }

  const kind = values.kind
  if (kind !== undefined && !isValidJournalKind(kind)) {
    io.stderr.write(`Invalid --kind "${kind}". Allowed values: ${JOURNAL_KINDS.join(', ')}\n\n${USAGE}`)
    return 1
  }

  const { records, skippedLineCount } = await readSessionWithStats(sessionId, {
    ...(journalDir !== undefined ? { dir: journalDir } : {}),
    ...(values.method !== undefined ? { method: values.method } : {}),
    ...(direction !== undefined ? { direction } : {}),
    ...(kind !== undefined ? { kind } : {}),
  })

  io.stdout.write(values.json === true ? formatRecordsJson(records) : formatRecordsReadable(records))
  if (skippedLineCount > 0) {
    io.stderr.write(`Skipped ${skippedLineCount} unreadable journal line(s).\n`)
  }
  return 0
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
