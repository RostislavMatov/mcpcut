import { parseArgs } from 'node:util'
import {
  AgentExistsError,
  AgentNotFoundError,
  createAgentsStore,
  InvalidAgentNameError,
  InvalidPromptPatternError,
  InvalidResourcePatternError,
  InvalidServerNameError,
  InvalidToolPatternError,
  type AgentsStore,
  type AgentsStoreOptions,
} from '../agents/store.js'
import { createGroupsStore } from '../groups/store.js'
import { formatReadableField } from '../journal/format.js'
import type { JournalSinkOptions } from '../journal/sink.js'
import { pairTarget, requireRegisteredServer } from './access-cmd-write.js'
import { formatAgentLine, formatGrantLines, summaryOf } from './agent-cmd-format.js'
import { recordChange, requireOwner, warnIfGroupsUncovered } from './agent-cmd-write.js'
import { resolveGrantFlags } from './grant-flags.js'
import { StoreCorruptError, StoreLockError, StoreWriteRejectedError } from '../policy/store.js'

/**
 * `agent create|list|grant|ungrant|revoke` — management of agent identities
 * and the personal grant matrix. Same shape as the other M2 command modules:
 * exported functions with injectable io/options, dispatched from `src/cli.ts`
 * and driven directly by tests.
 *
 * Reading (`agent list`) is free; every MUTATION needs a personal admin token
 * of role `owner` in `MCP_ADMIN_TOKEN` and is recorded twice — an audit line
 * on stderr and an `access-edit` journal record (owner decisions T4 and T1,
 * 2026-09-01; the gate and the record live in `agent-cmd-write.ts`). The token
 * buys ATTRIBUTION and parity with the UI's role table, not an access barrier.
 *
 * The ONE place a plaintext token ever surfaces is `agent create`'s stdout;
 * every other output path — the journal record included — renders hash-free,
 * `formatReadableField`-sanitized data read back from the store.
 */

/** Minimal writable-stream shape these commands need, so tests can inject capture objects. */
export interface AgentCliWritable {
  write(chunk: string): unknown
}

export interface AgentCliIo {
  readonly stdout: AgentCliWritable
  readonly stderr: AgentCliWritable
}

/** @internal test-only seams for the journal sink (retry delay, fault-injected commit). */
export interface AgentCliDeps {
  readonly sink?: Pick<JournalSinkOptions, 'retryDelayMs' | 'commitBatchImpl'>
}

/** Test seams: journal dir + clock (threaded into `createAgentsStore`), token env, sink. */
export interface AgentCliOptions extends AgentsStoreOptions {
  /** Environment holding `MCP_ADMIN_TOKEN`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  readonly deps?: AgentCliDeps
}

const DEFAULT_IO: AgentCliIo = { stdout: process.stdout, stderr: process.stderr }

const USAGE = `Usage:
  agent create <name>                          Create an agent; prints its token ONCE
  agent list                                   List agents and their grants
  agent grant <agent> <server> [--tools a,b,prefix*] [--resources uri,uriprefix*|*] [--prompts name,prefix*|*]
                                               Grant server access. NOTE the asymmetric defaults:
                                                 omitting --tools grants ALL tools ('*'),
                                                 omitting --resources keeps resources/* DENIED,
                                                 omitting --prompts keeps prompts/* DENIED
                                               (opening a method surface is always an explicit act)
  agent ungrant <agent> <server>               Remove the grant for a server
  agent revoke <name>                          Revoke the agent (its token stops working)
Every change needs a personal admin token in MCP_ADMIN_TOKEN (role owner); list does not.
`

/** Errors these commands convert into an exit-1 message instead of a crash. */
const EXPECTED_ERRORS = [
  AgentExistsError,
  AgentNotFoundError,
  InvalidAgentNameError,
  InvalidPromptPatternError,
  InvalidResourcePatternError,
  InvalidServerNameError,
  InvalidToolPatternError,
  StoreCorruptError,
  StoreLockError,
  StoreWriteRejectedError,
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
  const store = createAgentsStore(storeOptionsOf(opts))

  try {
    switch (subcommand) {
      case 'create':
        return await runCreate(rest, io, opts, store)
      case 'list':
        return await runList(io, store, opts)
      case 'grant':
        return await runGrant(rest, io, opts, store)
      case 'ungrant':
        return await runUngrant(rest, io, opts, store)
      case 'revoke':
        return await runRevoke(rest, io, opts, store)
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

/** The subset of the options the agents/groups stores take. */
function storeOptionsOf(opts: AgentCliOptions): AgentsStoreOptions {
  return {
    ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}),
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
  }
}

async function runCreate(
  args: string[],
  io: AgentCliIo,
  opts: AgentCliOptions,
  store: AgentsStore,
): Promise<number> {
  const name = args[0]
  if (name === undefined || args.length !== 1) {
    io.stderr.write(USAGE)
    return 1
  }
  // Refused BEFORE the write: an identity created by nobody is exactly what
  // T4 exists to prevent.
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1

  const { agent, token } = await store.createAgent(name)

  io.stdout.write(`agent: ${formatReadableField(agent.name)}\n`)
  io.stdout.write(`token: ${token}\n`)
  io.stdout.write('Save this token now: it cannot be recovered or shown again.\n')
  // The record names the agent and nothing else — the token stays in the one
  // place it was printed.
  return recordChange(io, opts, actor, 'create', formatReadableField(name), {
    action: 'agent.create',
    agent: name,
  })
}

async function runList(
  io: AgentCliIo,
  store: AgentsStore,
  options: AgentCliOptions,
): Promise<number> {
  const agents = await store.listAgents()
  if (agents.length === 0) {
    io.stdout.write('(no agents)\n')
    return 0
  }

  // The matrix an operator reads here must be the one the traffic path
  // decides against (G2), so the group half is read and merged in. A groups
  // document that cannot be read is NOT swallowed: rendering the personal
  // half alone would understate every member agent's access, which is the
  // one direction this listing must never be wrong in.
  const groups = await createGroupsStore(storeOptionsOf(options)).listGroups()

  for (const agent of agents) {
    io.stdout.write(`${formatAgentLine(agent)}\n`)
    for (const line of formatGrantLines(agent, groups)) {
      io.stdout.write(`${line}\n`)
    }
  }
  return 0
}

/** The two positionals and three flags of `agent grant`, or `undefined` with usage printed. */
interface GrantArgs {
  readonly agentName: string
  readonly serverName: string
  readonly tools: readonly string[] | '*'
  readonly methods: { readonly resources?: '*' | readonly string[]; readonly prompts?: '*' | readonly string[] }
}

function parseGrantArgs(args: string[], io: AgentCliIo): GrantArgs | undefined {
  let positionals: string[]
  let toolsValue: string | undefined
  let resourcesValue: string | undefined
  let promptsValue: string | undefined
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        tools: { type: 'string' },
        resources: { type: 'string' },
        prompts: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    positionals = parsed.positionals
    toolsValue = parsed.values.tools
    resourcesValue = parsed.values.resources
    promptsValue = parsed.values.prompts
  } catch {
    io.stderr.write(USAGE)
    return undefined
  }

  const [agentName, serverName] = positionals
  if (agentName === undefined || serverName === undefined || positionals.length !== 2) {
    io.stderr.write(USAGE)
    return undefined
  }

  // The flags (and the asymmetric defaults `group grant` no longer shares —
  // owner decision T2) are parsed by the module both commands use, so one
  // grant shape keeps one reading.
  const flags = resolveGrantFlags({ tools: toolsValue, resources: resourcesValue, prompts: promptsValue })
  if (!flags.ok) {
    io.stderr.write(flags.message)
    return undefined
  }
  return { agentName, serverName, tools: flags.tools, methods: flags.methods }
}

async function runGrant(
  args: string[],
  io: AgentCliIo,
  opts: AgentCliOptions,
  store: AgentsStore,
): Promise<number> {
  const parsed = parseGrantArgs(args, io)
  if (parsed === undefined) return 1
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1

  // Refused BEFORE the write (owner decision S1, 2026-09-03): the plane
  // cannot attach an agent to a server it does not have, and a typo must not
  // become a grant waiting for whatever is registered under that name later.
  const { agentName, serverName } = parsed
  if (!(await requireRegisteredServer(io, opts, serverName, { registerHint: true }))) return 1

  const agent = await store.grantServer(agentName, serverName, parsed.tools, parsed.methods)
  const grant = agent.grants[serverName]
  if (grant === undefined) throw new Error('grant vanished right after it was written')
  io.stdout.write(
    `granted ${formatReadableField(serverName)} to ${formatReadableField(agentName)}: ` +
      `${formatReadableField(summaryOf(grant.tools, 'all tools'))}\n`,
  )
  if (grant.resources !== undefined) {
    io.stdout.write(`  resources: ${formatReadableField(summaryOf(grant.resources, 'all resources'))}\n`)
  }
  if (grant.prompts !== undefined) {
    io.stdout.write(`  prompts: ${formatReadableField(summaryOf(grant.prompts, 'all prompts'))}\n`)
  }
  return recordChange(io, opts, actor, 'grant', pairTarget(agentName, serverName), {
    action: 'agent.grant',
    agent: agentName,
    server: serverName,
    grant,
  })
}

async function runUngrant(
  args: string[],
  io: AgentCliIo,
  opts: AgentCliOptions,
  store: AgentsStore,
): Promise<number> {
  const [agentName, serverName] = args
  if (agentName === undefined || serverName === undefined || args.length !== 2) {
    io.stderr.write(USAGE)
    return 1
  }
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1

  await store.ungrantServer(agentName, serverName)
  io.stdout.write(
    `removed grant ${formatReadableField(serverName)} from ${formatReadableField(agentName)}\n`,
  )
  await warnIfGroupsUncovered(agentName, serverName, io, opts)
  return recordChange(io, opts, actor, 'ungrant', pairTarget(agentName, serverName), {
    action: 'agent.ungrant',
    agent: agentName,
    server: serverName,
  })
}

async function runRevoke(
  args: string[],
  io: AgentCliIo,
  opts: AgentCliOptions,
  store: AgentsStore,
): Promise<number> {
  const name = args[0]
  if (name === undefined || args.length !== 1) {
    io.stderr.write(USAGE)
    return 1
  }
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1

  const agent = await store.revokeAgent(name)
  io.stdout.write(
    `revoked ${formatReadableField(agent.name)} at ${formatReadableField(agent.revokedAt ?? '')}\n`,
  )
  return recordChange(io, opts, actor, 'revoke', formatReadableField(name), {
    action: 'agent.revoke',
    agent: name,
  })
}
