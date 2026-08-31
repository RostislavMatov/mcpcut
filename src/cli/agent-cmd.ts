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
import type { AgentRecord } from '../agents/schema.js'
import { effectiveGrantsOf, type GrantSource } from '../agents/effective.js'
import type { GroupRecord } from '../groups/schema.js'
import { createGroupsStore } from '../groups/store.js'
import { formatReadableField } from '../journal/format.js'
import { resolveGrantFlags } from './grant-flags.js'
import { StoreCorruptError, StoreLockError, StoreWriteRejectedError } from '../policy/store.js'

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
  agent grant <agent> <server> [--tools a,b,prefix*] [--resources uri,uriprefix*|*] [--prompts name,prefix*|*]
                                               Grant server access. NOTE the asymmetric defaults:
                                                 omitting --tools grants ALL tools ('*'),
                                                 omitting --resources keeps resources/* DENIED,
                                                 omitting --prompts keeps prompts/* DENIED
                                               (opening a method surface is always an explicit act)
  agent ungrant <agent> <server>               Remove the grant for a server
  agent revoke <name>                          Revoke the agent (its token stops working)
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
  const store = createAgentsStore(opts)

  try {
    switch (subcommand) {
      case 'create':
        return await runCreate(rest, io, store)
      case 'list':
        return await runList(io, store, opts)
      case 'grant':
        return await runGrant(rest, io, store)
      case 'ungrant':
        return await runUngrant(rest, io, store, opts)
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
  const groups = await createGroupsStore(options).listGroups()

  for (const agent of agents) {
    io.stdout.write(`${formatAgentLine(agent)}\n`)
    for (const line of formatGrantLines(agent, groups)) {
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

/**
 * Indented lines per EFFECTIVE granted server: `<server>: tool, tool` (or
 * `* (all tools)`), plus one extra line each for the resources/prompts
 * dimensions when present (M4 Task 6) — absent fields print nothing, so
 * pre-M4 grants render exactly as before.
 *
 * Rows carry their provenance when a group is involved: ` (via group:…)` for
 * a server the agent only reaches through its groups, ` (overrides group:…)`
 * for a personal grant that takes a server the groups also grant (G2 — the
 * personal grant wins WHOLESALE, so the tools shown are the personal ones).
 * An agent in no group has neither suffix and renders byte-identically to
 * before groups existed.
 */
function formatGrantLines(agent: AgentRecord, groups: readonly GroupRecord[]): string[] {
  const effective = effectiveGrantsOf(agent, groups)
  const entries = Object.entries(effective.grants)
  if (entries.length === 0) {
    return ['  (no grants)']
  }
  return entries.flatMap(([server, grant]) => {
    const origin = formatOrigin(effective.sources, server)
    const lines = [
      `  ${formatReadableField(server)}: ${formatPatterns(grant.tools, 'all tools')}${origin}`,
    ]
    if (grant.resources !== undefined) {
      lines.push(`    resources: ${formatPatterns(grant.resources, 'all resources')}`)
    }
    if (grant.prompts !== undefined) {
      lines.push(`    prompts: ${formatPatterns(grant.prompts, 'all prompts')}`)
    }
    return lines
  })
}

/**
 * The provenance suffix of one row, or `''` when no group is involved.
 * `Object.hasOwn` because the key is a server name read off a document.
 */
function formatOrigin(sources: Readonly<Record<string, GrantSource>>, server: string): string {
  const source = Object.hasOwn(sources, server) ? sources[server] : undefined
  if (source === undefined) return ''
  const names = source.kind === 'group' ? source.groups : source.shadowedGroups
  if (names.length === 0) return ''
  const label = source.kind === 'group' ? 'via' : 'overrides'
  const list = names.map((name) => `group:${formatReadableField(name)}`).join(', ')
  return ` (${label} ${list})`
}

/** `'*'` → `* (all …)`; array → sanitized, comma-joined patterns. */
function formatPatterns(patterns: '*' | readonly string[], everything: string): string {
  return patterns === '*'
    ? `* (${everything})`
    : patterns.map(formatReadableField).join(', ')
}

async function runGrant(args: string[], io: AgentCliIo, store: AgentsStore): Promise<number> {
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
    return 1
  }

  const [agentName, serverName] = positionals
  if (agentName === undefined || serverName === undefined || positionals.length !== 2) {
    io.stderr.write(USAGE)
    return 1
  }

  // The flags (and their asymmetric defaults) are parsed by the module
  // `group grant` shares, so one grant shape keeps one reading.
  const flags = resolveGrantFlags({ tools: toolsValue, resources: resourcesValue, prompts: promptsValue })
  if (!flags.ok) {
    io.stderr.write(flags.message)
    return 1
  }

  const agent = await store.grantServer(agentName, serverName, flags.tools, flags.methods)
  const grant = agent.grants[serverName]
  const summary = grant?.tools === '*' ? '* (all tools)' : (grant?.tools ?? []).join(', ')
  io.stdout.write(
    `granted ${formatReadableField(serverName)} to ${formatReadableField(agentName)}: ${formatReadableField(summary)}\n`,
  )
  if (grant?.resources !== undefined) {
    io.stdout.write(`  resources: ${formatReadableField(summaryOf(grant.resources, 'all resources'))}\n`)
  }
  if (grant?.prompts !== undefined) {
    io.stdout.write(`  prompts: ${formatReadableField(summaryOf(grant.prompts, 'all prompts'))}\n`)
  }
  return 0
}

/** `'*'` → `* (all …)`; array → raw comma-joined patterns (sanitized by the caller). */
function summaryOf(patterns: '*' | readonly string[], everything: string): string {
  return patterns === '*' ? `* (${everything})` : patterns.join(', ')
}

async function runUngrant(
  args: string[],
  io: AgentCliIo,
  store: AgentsStore,
  options: AgentCliOptions,
): Promise<number> {
  const [agentName, serverName] = args
  if (agentName === undefined || serverName === undefined || args.length !== 2) {
    io.stderr.write(USAGE)
    return 1
  }

  await store.ungrantServer(agentName, serverName)
  io.stdout.write(
    `removed grant ${formatReadableField(serverName)} from ${formatReadableField(agentName)}\n`,
  )
  await warnIfGroupsUncovered(agentName, serverName, io, options)
  return 0
}

/**
 * A personal grant takes its server WHOLE, shadowing whatever the agent's
 * groups grant for it (ADR-0010 §2). Removing it therefore does not deny the
 * server — it hands the agent the groups' (unioned, usually wider) grant. The
 * shell is told so, because "removed grant" alone reads as de-escalation.
 *
 * Read AFTER the write, so the groups named are the ones the agent actually
 * falls back to now. A groups document that cannot be read must not turn a
 * completed ungrant into a failure: the removal happened either way, and the
 * warning is advisory.
 */
async function warnIfGroupsUncovered(
  agentName: string,
  serverName: string,
  io: AgentCliIo,
  options: AgentCliOptions,
): Promise<void> {
  let inheritedFrom: readonly string[]
  try {
    const memberships = await createGroupsStore(options).groupsOf(agentName)
    inheritedFrom = memberships
      .filter((group) => Object.hasOwn(group.grants, serverName))
      .map((group) => group.name)
  } catch (error: unknown) {
    // Advisory, but never silent: "I could not look" must be distinguishable
    // from "there is nothing to warn about" — same shape as
    // `server-grant-refs.ts`'s failed lookup. The ungrant itself already
    // landed, so the exit code stays 0.
    const reason = error instanceof Error ? error.message : String(error)
    io.stderr.write(
      `[warn] could not check group grants for ${formatReadableField(agentName)}: ${reason}\n`,
    )
    return
  }
  if (inheritedFrom.length === 0) return
  const from = inheritedFrom.map((name) => `group:${formatReadableField(name)}`).join(', ')
  io.stderr.write(
    `[warn] ${formatReadableField(agentName)} now inherits ${formatReadableField(serverName)}` +
      ` from ${from} — effective access WIDENED\n`,
  )
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
