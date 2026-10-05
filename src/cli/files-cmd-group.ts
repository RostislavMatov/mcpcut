import { parseArgs } from 'node:util'
import type { AgentGrant } from '../agents/schema.js'
import { createAgentsStore } from '../agents/store.js'
import { FILES_SERVER_NAME } from '../files/constants.js'
import {
  applyRule,
  dropRule,
  filesGrantsOf,
  normalizeOps,
  resolveRulePath,
  RuleRefusedError,
  ruleKeysOf,
} from '../files/grant-admin.js'
import { createRootsStore } from '../files/roots-store.js'
import type { GroupRecord } from '../groups/schema.js'
import { createGroupsStore, type GroupsStore } from '../groups/store.js'
import { formatReadableField, replaceControlChars } from '../journal/format.js'
import { pairTarget } from './access-cmd-write.js'
import type { AgentCliIo } from './agent-cmd.js'
import { FILES_USAGE, formatRuleLines } from './files-cmd-format.js'
import { conflictMessage, filesServerState, notRegisteredMessage } from './files-cmd-registry.js'
import { fail, parseOps, record, registryOf, requireOwner } from './files-cmd-write.js'
import type { FilesCliOptions } from './files-cmd.js'
import { cliCommand, shellArg } from './next-step.js'

/**
 * `mcpcut files grant|revoke|show --group <group>` — the folder rules of a
 * group (ADR-0020 §2): the same rule helpers as the per-agent forms, applied
 * to the group's `files` grant, so every member inherits the change at once.
 */

/** Whether the args address a group; the one test the dispatcher makes. */
export function isGroupForm(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--group' || arg.startsWith('--group='))
}

interface GroupArgs {
  readonly group: string
  readonly positionals: readonly string[]
  readonly ops: string | undefined
}

function parseGroupArgs(args: readonly string[], count: number, withOps: boolean): GroupArgs | undefined {
  try {
    const parsed = parseArgs({
      args: [...args],
      options: { group: { type: 'string' }, ...(withOps ? { ops: { type: 'string' } } : {}) },
      allowPositionals: true,
      strict: true,
    })
    const values = parsed.values as { group?: string; ops?: string }
    if (values.group === undefined || values.group === '' || parsed.positionals.length !== count) return undefined
    return { group: values.group, positionals: parsed.positionals, ops: values.ops }
  } catch {
    return undefined
  }
}

/** Names of the agents that can still connect, for a ready `group join` command. */
async function activeAgentNames(opts: FilesCliOptions): Promise<readonly string[]> {
  const agents = await createAgentsStore({ ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}) }).listAgents()
  return agents.filter((agent) => agent.revokedAt === undefined).map((agent) => agent.name)
}

function groupsOf(opts: FilesCliOptions): GroupsStore {
  return createGroupsStore({ ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}) })
}

/** The group, or the one-line refusal with the way to list groups. */
async function findGroup(io: AgentCliIo, opts: FilesCliOptions, name: string): Promise<GroupRecord | undefined> {
  const group = await groupsOf(opts).getGroup(name)
  if (group === undefined) fail(io, unknownGroupLine(opts, name))
  return group
}

function unknownGroupLine(opts: FilesCliOptions, name: string): string {
  return `no group "${formatReadableField(name)}": list groups with \`${cliCommand(opts.env)} group list\``
}

/**
 * Who gets the change: the members, with a check command; or how to add the
 * first one — named after an existing agent when there is one.
 */
export function memberNextStep(env: NodeJS.ProcessEnv | undefined, group: GroupRecord, agentNames: readonly string[] = []): string {
  const cli = cliCommand(env)
  const [first] = group.members
  if (first === undefined) {
    const candidate = agentNames[0] === undefined ? '<agent>' : shellArg(agentNames[0])
    return `No agent is in ${formatReadableField(group.name)} yet. Add one: ${cli} group join ${shellArg(group.name)} ${candidate}\n`
  }
  const names = group.members.map(formatReadableField).join(', ')
  return `Agents in ${formatReadableField(group.name)} get it: ${names}. Check one: ${cli} files show ${shellArg(first)}\n`
}

function filesGrantOf(group: GroupRecord): AgentGrant | undefined {
  return Object.hasOwn(group.grants, FILES_SERVER_NAME) ? group.grants[FILES_SERVER_NAME] : undefined
}

export async function runGroupGrant(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const parsed = parseGroupArgs(args, 1, true)
  const rawPath = parsed?.positionals[0]
  if (parsed === undefined || rawPath === undefined) return fail(io, FILES_USAGE.trimEnd())
  const { group: groupName } = parsed
  if (parsed.ops === undefined) {
    return fail(io, `--ops is required, e.g. \`${cliCommand(opts.env)} files grant --group ${shellArg(groupName)} ${shellArg(rawPath)} --ops read\` (or --ops none to cut a folder out)`)
  }
  const ops = parseOps(parsed.ops)
  if (!ops.ok) return fail(io, ops.message)
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1
  if ((await findGroup(io, opts, groupName)) === undefined) return 1
  const state = await filesServerState(registryOf(opts))
  if (state === 'conflict') return fail(io, conflictMessage(opts.env))
  if (state === 'missing') return fail(io, notRegisteredMessage(opts.env, shellArg(rawPath)))

  const roots = await createRootsStore({ ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}) }).list()
  const resolved = await resolveRulePath(roots.map((root) => root.path), rawPath, (folder) => `${cliCommand(opts.env)} files root add ${shellArg(folder)}`)
  if (!resolved.ok) return fail(io, replaceControlChars(resolved.message))
  const rule = { path: resolved.path, ops: normalizeOps(ops.ops) }

  const updated = await groupsOf(opts).setServerGrant(groupName, FILES_SERVER_NAME, (current) => {
    const applied = applyRule(filesGrantsOf(current), rule)
    if (!applied.ok) throw new RuleRefusedError(applied.message.replace('<agent>', '--group <group>'))
    return applied.grants[FILES_SERVER_NAME] as AgentGrant
  })
  const grant = filesGrantOf(updated) as AgentGrant
  const label = formatReadableField(groupName)
  io.stdout.write(`granted group ${label} on ${formatReadableField(rule.path)}: ${rule.ops.length === 0 ? 'no access (cut out)' : rule.ops.join(', ')}\n`)
  io.stdout.write(`group ${label}'s folder rules:\n${formatRuleLines(grant.paths ?? []).join('\n')}\n`)
  io.stderr.write(memberNextStep(opts.env, updated, await activeAgentNames(opts)))
  return record(io, opts, actor, 'grant', pairTarget(groupName, rule.path), {
    action: 'files.grant',
    group: groupName,
    server: FILES_SERVER_NAME,
    path: rule.path,
    grant,
  })
}

export async function runGroupRevoke(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const parsed = parseGroupArgs(args, 1, false)
  const rawPath = parsed?.positionals[0]
  if (parsed === undefined || rawPath === undefined) return fail(io, FILES_USAGE.trimEnd())
  const { group: groupName } = parsed
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1
  const existing = await findGroup(io, opts, groupName)
  if (existing === undefined) return 1

  const keys = await ruleKeysOf(rawPath)
  const label = formatReadableField(groupName)
  if (!dropRule(filesGrantsOf(filesGrantOf(existing)), keys).removed) {
    return fail(io, `group ${label} has no rule for ${formatReadableField(rawPath)}: see its rules with \`${cliCommand(opts.env)} files show --group ${shellArg(groupName)}\``)
  }
  const updated = await groupsOf(opts).setServerGrant(groupName, FILES_SERVER_NAME, (current) => {
    const dropped = dropRule(filesGrantsOf(current), keys)
    if (!dropped.removed) throw new RuleRefusedError('the rule was removed meanwhile: run files show --group to see the current rules')
    return dropped.grants[FILES_SERVER_NAME] as AgentGrant
  })
  const grant = filesGrantOf(updated) as AgentGrant
  io.stdout.write(`revoked ${formatReadableField(keys[0] ?? rawPath)} from group ${label}\n`)
  if (grant.paths === undefined) {
    io.stdout.write(`group ${label} now has no file access\n`)
  } else {
    io.stdout.write(`group ${label}'s folder rules:\n${formatRuleLines(grant.paths).join('\n')}\n`)
  }
  io.stderr.write(memberNextStep(opts.env, updated, await activeAgentNames(opts)))
  return record(io, opts, actor, 'revoke', pairTarget(groupName, keys[0] ?? rawPath), {
    action: 'files.revoke',
    group: groupName,
    server: FILES_SERVER_NAME,
    path: keys[0] ?? rawPath,
    grant,
  })
}

export async function runGroupShow(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const parsed = parseGroupArgs(args, 0, false)
  if (parsed === undefined) return fail(io, FILES_USAGE.trimEnd())
  const group = await findGroup(io, opts, parsed.group)
  if (group === undefined) return 1
  const label = formatReadableField(group.name)
  const members = group.members.length === 0 ? 'none yet' : group.members.map(formatReadableField).join(', ')
  const rules = filesGrantOf(group)?.paths ?? []
  const cli = cliCommand(opts.env)
  if (rules.length === 0) {
    io.stdout.write(`group ${label} has no file access (members: ${members})\n`)
    io.stderr.write(`Give a folder: ${cli} files grant --group ${shellArg(group.name)} <folder> --ops read\n`)
    return 0
  }
  io.stdout.write(`group ${label}'s folder rules (members: ${members}):\n${formatRuleLines(rules).join('\n')}\n`)
  io.stderr.write(`Change one: ${cli} files grant --group ${shellArg(group.name)} ${shellArg(rules[0]?.path ?? '<folder>')} --ops read\n`)
  return 0
}
