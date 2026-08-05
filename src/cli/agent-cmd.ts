import { parseArgs } from 'node:util'
import {
  AgentExistsError,
  AgentNotFoundError,
  createAgentsStore,
  InvalidAgentNameError,
  InvalidServerNameError,
  InvalidToolPatternError,
  type AgentsStore,
  type AgentsStoreOptions,
} from '../agents/store.js'
import type { AgentRecord } from '../agents/schema.js'
import { formatReadableField } from '../journal/format.js'
import { StoreCorruptError, StoreLockError } from '../policy/store.js'

/**
 * `agent create|list|grant|ungrant|revoke` — operator-facing management of
 * agent identities and the grant matrix. Same shape as the other M2 command
 * modules: exported functions with injectable io/options, dispatched from
 * `src/cli.ts` (wired in Wave 4) and driven directly by tests.
 *
 * The ONE place a plaintext token ever surfaces is `agent create`'s stdout;
 * every other output path renders hashes-free, `formatReadableField`-sanitized
 * data read back from the store file.
 */

/** Minimal writable-stream shape these commands need, so tests can inject capture objects. */
export interface AgentCliWritable {
  write(chunk: string): unknown
}

export interface AgentCliIo {
  readonly stdout: AgentCliWritable
  readonly stderr: AgentCliWritable
}

/** Test seams: journal dir + clock, threaded into `createAgentsStore`. */
export type AgentCliOptions = AgentsStoreOptions

const DEFAULT_IO: AgentCliIo = { stdout: process.stdout, stderr: process.stderr }

const USAGE = `Usage:
  agent create <name>                          Create an agent; prints its token ONCE
  agent list                                   List agents and their grants
  agent grant <agent> <server> [--tools a,b,prefix*]
                                               Grant server access (no --tools = all tools)
  agent ungrant <agent> <server>               Remove the grant for a server
  agent revoke <name>                          Revoke the agent (its token stops working)
`

/** Errors these commands convert into an exit-1 message instead of a crash. */
const EXPECTED_ERRORS = [
  AgentExistsError,
  AgentNotFoundError,
  InvalidAgentNameError,
  InvalidServerNameError,
  InvalidToolPatternError,
  StoreCorruptError,
  StoreLockError,
] as const

function isExpectedError(error: unknown): error is Error {
  return EXPECTED_ERRORS.some((kind) => error instanceof kind)
}

/**
 * Dispatches an `agent ...` subcommand. Returns a process exit code; only
 * unexpected (programming/filesystem) errors propagate as rejections.
 */
export async function runAgentCommand(
  args: string[],
  io: AgentCliIo = DEFAULT_IO,
  opts: AgentCliOptions = {},
): Promise<number> {
  const [subcommand, ...rest] = args
  const store = createAgentsStore(opts)

  try {
    switch (subcommand) {
      case 'create':
        return await runCreate(rest, io, store)
      case 'list':
        return await runList(io, store)
      case 'grant':
        return await runGrant(rest, io, store)
      case 'ungrant':
        return await runUngrant(rest, io, store)
      case 'revoke':
        return await runRevoke(rest, io, store)
      default:
        io.stderr.write(USAGE)
        return 1
    }
  } catch (error: unknown) {
    if (isExpectedError(error)) {
      // Error messages embed operator-typed names — sanitized before they
      // reach the terminal, like every untrusted string in the M2 CLIs.
      io.stderr.write(`${formatReadableField(error.message)}\n`)
      return 1
    }
    throw error
  }
}

async function runCreate(args: string[], io: AgentCliIo, store: AgentsStore): Promise<number> {
  const name = args[0]
  if (name === undefined || args.length !== 1) {
    io.stderr.write(USAGE)
    return 1
  }

  const { agent, token } = await store.createAgent(name)

  io.stdout.write(`agent: ${formatReadableField(agent.name)}\n`)
  io.stdout.write(`token: ${token}\n`)
  io.stdout.write('Save this token now: it cannot be recovered or shown again.\n')
  return 0
}

async function runList(io: AgentCliIo, store: AgentsStore): Promise<number> {
  const agents = await store.listAgents()
  if (agents.length === 0) {
    io.stdout.write('(no agents)\n')
    return 0
  }

  for (const agent of agents) {
    io.stdout.write(`${formatAgentLine(agent)}\n`)
    for (const line of formatGrantLines(agent)) {
      io.stdout.write(`${line}\n`)
    }
  }
  return 0
}

/** Header line: name, creation date, revocation marker. Never the token hash. */
function formatAgentLine(agent: AgentRecord): string {
  const name = formatReadableField(agent.name)
  const created = `created ${formatReadableField(agent.createdAt)}`
  const revoked =
    agent.revokedAt === undefined ? '' : `  REVOKED ${formatReadableField(agent.revokedAt)}`
  return `${name}  ${created}${revoked}`
}

/** One indented line per granted server: `<server>: tool, tool` or `* (all tools)`. */
function formatGrantLines(agent: AgentRecord): string[] {
  const entries = Object.entries(agent.grants)
  if (entries.length === 0) {
    return ['  (no grants)']
  }
  return entries.map(([server, grant]) => {
    const tools =
      grant.tools === '*'
        ? '* (all tools)'
        : grant.tools.map(formatReadableField).join(', ')
    return `  ${formatReadableField(server)}: ${tools}`
  })
}

async function runGrant(args: string[], io: AgentCliIo, store: AgentsStore): Promise<number> {
  let positionals: string[]
  let toolsValue: string | undefined
  try {
    const parsed = parseArgs({
      args: [...args],
      options: { tools: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    })
    positionals = parsed.positionals
    toolsValue = parsed.values.tools
  } catch {
    io.stderr.write(USAGE)
    return 1
  }

  const [agentName, serverName] = positionals
  if (agentName === undefined || serverName === undefined || positionals.length !== 2) {
    io.stderr.write(USAGE)
    return 1
  }

  const tools = parseToolsFlag(toolsValue)
  if (tools === 'empty') {
    io.stderr.write('--tools was given but contains no tool patterns (expected e.g. --tools get_*,list_issues)\n')
    return 1
  }

  const agent = await store.grantServer(agentName, serverName, tools)
  const grant = agent.grants[serverName]
  const summary = grant?.tools === '*' ? '* (all tools)' : (grant?.tools ?? []).join(', ')
  io.stdout.write(
    `granted ${formatReadableField(serverName)} to ${formatReadableField(agentName)}: ${formatReadableField(summary)}\n`,
  )
  return 0
}

/** No flag → `'*'`; a flag that boils down to zero patterns → `'empty'` (an error). */
function parseToolsFlag(value: string | undefined): readonly string[] | '*' | 'empty' {
  if (value === undefined) return '*'
  const patterns = value
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
  return patterns.length === 0 ? 'empty' : patterns
}

async function runUngrant(args: string[], io: AgentCliIo, store: AgentsStore): Promise<number> {
  const [agentName, serverName] = args
  if (agentName === undefined || serverName === undefined || args.length !== 2) {
    io.stderr.write(USAGE)
    return 1
  }

  await store.ungrantServer(agentName, serverName)
  io.stdout.write(
    `removed grant ${formatReadableField(serverName)} from ${formatReadableField(agentName)}\n`,
  )
  return 0
}

async function runRevoke(args: string[], io: AgentCliIo, store: AgentsStore): Promise<number> {
  const name = args[0]
  if (name === undefined || args.length !== 1) {
    io.stderr.write(USAGE)
    return 1
  }

  const agent = await store.revokeAgent(name)
  io.stdout.write(
    `revoked ${formatReadableField(agent.name)} at ${formatReadableField(agent.revokedAt ?? '')}\n`,
  )
  return 0
}
