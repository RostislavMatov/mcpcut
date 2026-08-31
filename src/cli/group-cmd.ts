import {
  createAgentsStore,
  InvalidAgentNameError,
  InvalidPromptPatternError,
  InvalidResourcePatternError,
  InvalidServerNameError,
  InvalidToolPatternError,
} from '../agents/store.js'
import {
  createGroupsStore,
  GroupExistsError,
  GroupNotFoundError,
  GroupsFileInvalidError,
  InvalidGroupNameError,
  type GroupsStore,
} from '../groups/store.js'
import { formatReadableField } from '../journal/format.js'
import type { JournalSinkOptions } from '../journal/sink.js'
import { StoreCorruptError, StoreLockError, StoreWriteRejectedError } from '../policy/store.js'
import { createRegistryStore } from '../registry/store.js'
import {
  hasPositionals,
  oneName,
  parseGrantArgs,
  twoNames,
  USAGE,
} from './group-cmd-args.js'
import {
  formatGrantEcho,
  formatGroupDetail,
  formatGroupTable,
  formatMembers,
  pairTarget,
} from './group-cmd-format.js'
import { recordChange, requireOwner } from './group-cmd-write.js'

/**
 * `group create|remove|list|show|grant|ungrant|join|leave` — the CLI surface
 * of server groups (plan m55-server-groups, Task 9; owner decision G4). Same
 * shape as `agent-cmd.ts`: exported function returning an exit code, with
 * injectable io and options, dispatched from `src/cli.ts` and driven directly
 * by tests.
 *
 * Reading is free; every MUTATION needs a personal admin token of role
 * `owner` in `MCP_ADMIN_TOKEN` and is recorded twice — an audit line on
 * stderr next to the shell that made it, and an `access-edit` journal record
 * (ADR-0009 O5/O6). The token buys ATTRIBUTION and parity with the UI's role
 * table, not an access barrier: a process under the same uid can edit the
 * store file anyway (ADR-0004).
 *
 * Existence of the granted server and of the joining agent is checked HERE,
 * not in the store: the stores stay independent of each other by design
 * (`agents/constants.ts` states the same rule for grants), so the layer that
 * has both is the one that can refuse a typo.
 */

export { GROUP_MIN_ROLE } from './group-cmd-args.js'

/** Minimal writable-stream shape these commands need, so tests can inject capture objects. */
export interface GroupCliWritable {
  write(chunk: string): unknown
}

export interface GroupCliIo {
  readonly stdout: GroupCliWritable
  readonly stderr: GroupCliWritable
}

/** @internal test-only seams for the journal sink (retry delay, fault-injected commit). */
export interface GroupCliDeps {
  readonly sink?: Pick<JournalSinkOptions, 'retryDelayMs' | 'commitBatchImpl'>
}

export interface GroupCliOptions {
  /** Directory holding `state.db` (groups, agents, registry, admins) and `journal.db`. Defaults to `JOURNAL_DIR`. */
  readonly journalDir?: string
  /** Environment holding `MCP_ADMIN_TOKEN`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Clock override for deterministic timestamps in tests. */
  readonly clock?: () => Date
  readonly deps?: GroupCliDeps
}

const DEFAULT_IO: GroupCliIo = { stdout: process.stdout, stderr: process.stderr }

/** Errors these commands convert into an exit-1 message instead of a crash. */
const EXPECTED_ERRORS = [
  GroupExistsError,
  GroupNotFoundError,
  GroupsFileInvalidError,
  InvalidAgentNameError,
  InvalidGroupNameError,
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
 * Dispatches a `group ...` subcommand. Returns a process exit code; only
 * unexpected (programming/filesystem) errors propagate as rejections.
 */
export async function runGroupCommand(
  args: string[],
  io: GroupCliIo = DEFAULT_IO,
  opts: GroupCliOptions = {},
): Promise<number> {
  const [subcommand, ...rest] = args
  const store = makeStore(opts)

  try {
    switch (subcommand) {
      case 'create':
        return await runCreate(rest, io, opts, store)
      case 'remove':
        return await runRemove(rest, io, opts, store)
      case 'list':
        return await runList(rest, io, store)
      case 'show':
        return await runShow(rest, io, store)
      case 'grant':
        return await runGrant(rest, io, opts, store)
      case 'ungrant':
        return await runUngrant(rest, io, opts, store)
      case 'join':
        return await runJoin(rest, io, opts, store)
      case 'leave':
        return await runLeave(rest, io, opts, store)
      default:
        io.stderr.write(USAGE)
        return 1
    }
  } catch (error: unknown) {
    if (isExpectedError(error)) {
      // Messages embed operator-typed names — sanitized before they reach the
      // terminal, like every untrusted string in the M2/M3 CLIs.
      io.stderr.write(`${formatReadableField(error.message)}\n`)
      return 1
    }
    throw error
  }
}

function makeStore(opts: GroupCliOptions): GroupsStore {
  return createGroupsStore({
    ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}),
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
  })
}

async function runCreate(
  args: string[],
  io: GroupCliIo,
  opts: GroupCliOptions,
  store: GroupsStore,
): Promise<number> {
  const name = oneName(args, io)
  if (name === undefined) return 1
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1

  const group = await store.createGroup(name)
  io.stdout.write(`created group ${formatReadableField(group.name)}\n`)
  return recordChange(io, opts, actor, 'create', formatReadableField(name), {
    action: 'group.create',
    group: name,
  })
}

async function runRemove(
  args: string[],
  io: GroupCliIo,
  opts: GroupCliOptions,
  store: GroupsStore,
): Promise<number> {
  const name = oneName(args, io)
  if (name === undefined) return 1
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1

  const result = await store.removeGroup(name)
  if (result.status === 'not-found') {
    io.stderr.write(`group "${formatReadableField(name)}" does not exist\n`)
    return 1
  }
  if (result.status === 'has-members') {
    // A refusal, not a failure (G3): the members are named so the operator can
    // empty the group instead of guessing who still inherits its grants.
    io.stderr.write(
      `group "${formatReadableField(name)}" still has members: ${formatMembers(result.members)} — remove them first\n`,
    )
    return 1
  }

  io.stdout.write(`removed group ${formatReadableField(name)}\n`)
  return recordChange(io, opts, actor, 'remove', formatReadableField(name), {
    action: 'group.remove',
    group: name,
  })
}

async function runList(args: string[], io: GroupCliIo, store: GroupsStore): Promise<number> {
  if (!hasPositionals(args, 0)) {
    io.stderr.write(USAGE)
    return 1
  }
  io.stdout.write(formatGroupTable(await store.listGroups()))
  return 0
}

async function runShow(args: string[], io: GroupCliIo, store: GroupsStore): Promise<number> {
  const name = oneName(args, io)
  if (name === undefined) return 1

  const group = await store.getGroup(name)
  if (group === undefined) {
    io.stderr.write(`group "${formatReadableField(name)}" does not exist\n`)
    return 1
  }
  io.stdout.write(formatGroupDetail(group))
  return 0
}

async function runGrant(
  args: string[],
  io: GroupCliIo,
  opts: GroupCliOptions,
  store: GroupsStore,
): Promise<number> {
  const parsed = parseGrantArgs(args, io)
  if (parsed === undefined) return 1
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1

  // A grant for a server nobody registered is a typo, not a policy: the
  // registry is the source of truth for what a group can name.
  const registered = await createRegistryStore(opts.journalDir).getServer(parsed.server)
  if (registered === undefined) {
    io.stderr.write(`unknown server "${formatReadableField(parsed.server)}"\n`)
    return 1
  }

  const group = await store.grantServer(parsed.group, parsed.server, parsed.tools, parsed.methods)
  const grant = group.grants[parsed.server]
  if (grant === undefined) throw new Error('grant vanished right after it was written')
  io.stdout.write(formatGrantEcho(parsed.group, parsed.server, grant))
  return recordChange(io, opts, actor, 'grant', pairTarget(parsed.group, parsed.server), {
    action: 'group.grant',
    group: parsed.group,
    server: parsed.server,
    grant,
  })
}

async function runUngrant(
  args: string[],
  io: GroupCliIo,
  opts: GroupCliOptions,
  store: GroupsStore,
): Promise<number> {
  const parsed = twoNames(args, io)
  if (parsed === undefined) return 1
  const [group, server] = parsed
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1

  // Nothing removed → nothing to attribute: an `access-edit` record for a
  // change that did not happen would show an auditor a phantom `group.ungrant`.
  const result = await store.ungrantServer(group, server)
  if (result.status === 'absent') {
    io.stderr.write(
      `group "${formatReadableField(group)}" has no grant for "${formatReadableField(server)}"\n`,
    )
    return 1
  }

  io.stdout.write(
    `removed grant ${formatReadableField(server)} from group ${formatReadableField(group)}\n`,
  )
  return recordChange(io, opts, actor, 'ungrant', pairTarget(group, server), {
    action: 'group.ungrant',
    group,
    server,
  })
}

async function runJoin(
  args: string[],
  io: GroupCliIo,
  opts: GroupCliOptions,
  store: GroupsStore,
): Promise<number> {
  const parsed = twoNames(args, io)
  if (parsed === undefined) return 1
  const [group, agentName] = parsed
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1

  // Fail closed on both counts: a member nobody created is a typo, and a
  // revoked agent must not be handed a fresh path to a server — re-creating
  // the identity is the deliberate act, not silently re-admitting it.
  const agent = await createAgentsStore(
    opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {},
  ).getAgent(agentName)
  if (agent === undefined) {
    io.stderr.write(`unknown agent "${formatReadableField(agentName)}"\n`)
    return 1
  }
  if (agent.revokedAt !== undefined) {
    io.stderr.write(`agent "${formatReadableField(agentName)}" is revoked\n`)
    return 1
  }

  await store.addMember(group, agentName)
  io.stdout.write(
    `added ${formatReadableField(agentName)} to group ${formatReadableField(group)}\n`,
  )
  return recordChange(io, opts, actor, 'join', pairTarget(group, agentName), {
    action: 'group.join',
    group,
    agent: agentName,
  })
}

async function runLeave(
  args: string[],
  io: GroupCliIo,
  opts: GroupCliOptions,
  store: GroupsStore,
): Promise<number> {
  const parsed = twoNames(args, io)
  if (parsed === undefined) return 1
  const [group, agentName] = parsed
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1

  // Deliberately NOT checked against the agents store: taking access away must
  // work even for a member whose agent no longer exists.
  // Same rule as `ungrant`: a `group.leave` record is only written for a
  // membership that actually ended.
  const result = await store.removeMember(group, agentName)
  if (result.status === 'absent') {
    io.stderr.write(
      `group "${formatReadableField(group)}" has no member "${formatReadableField(agentName)}"\n`,
    )
    return 1
  }

  io.stdout.write(
    `removed ${formatReadableField(agentName)} from group ${formatReadableField(group)}\n`,
  )
  return recordChange(io, opts, actor, 'leave', pairTarget(group, agentName), {
    action: 'group.leave',
    group,
    agent: agentName,
  })
}
