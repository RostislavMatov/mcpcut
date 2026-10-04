import { parseArgs } from 'node:util'
import { createAgentsStore, type AgentsStore } from '../agents/store.js'
import type { AgentGrant, AgentRecord } from '../agents/schema.js'
import { FILE_OPS, FILES_SERVER_NAME, type FileOp } from '../files/constants.js'
import {
  applyRule,
  dropRule,
  filesGrantsOf,
  normalizeOps,
  resolveRulePath,
  RuleRefusedError,
  ruleKeysOf,
} from '../files/grant-admin.js'
import { prepareRoot } from '../files/roots-admin.js'
import { createRootsStore } from '../files/roots-store.js'
import { createRegistryStore } from '../registry/store.js'
import { formatReadableField, replaceControlChars } from '../journal/format.js'
import type { AdminRefusalWording, RequiredAdmin } from './admin-token.js'
import { pairTarget, recordAccessChange, requireAccessOwner, type AccessOp } from './access-cmd-write.js'
import type { AgentCliIo } from './agent-cmd.js'
import { formatRuleLines, grantNextStep, FILES_USAGE } from './files-cmd-format.js'
import { conflictMessage, filesServerState, notRegisteredMessage, registerFilesServer } from './files-cmd-registry.js'
import type { FilesCliOptions } from './files-cmd.js'
import { cliCommand, shellArg } from './next-step.js'

/** The mutating `files` subcommands: owner gate first, then the store, then the audit line and journal record. */

const FILES_REFUSAL: AdminRefusalWording = {
  action: 'change file roots or folder rules',
  noun: 'change',
  verb: 'may not change file rights',
  roleDetail: 'the same rule `agent grant` follows',
}

const OPS_EXAMPLE = 'read,write,edit,delete'

export function requireOwner(io: AgentCliIo, opts: FilesCliOptions): Promise<RequiredAdmin | undefined> {
  return requireAccessOwner(io, opts, FILES_REFUSAL)
}

export function fail(io: AgentCliIo, line: string): number {
  io.stderr.write(`${line}\n`)
  return 1
}

function storesOf(opts: FilesCliOptions): { agents: AgentsStore } {
  return { agents: createAgentsStore({ ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}) }) }
}

export function registryOf(opts: FilesCliOptions) {
  return createRegistryStore(opts.journalDir)
}

/** The agent, or the one-line refusal with the way to list agents. */
export async function findAgent(io: AgentCliIo, opts: FilesCliOptions, name: string): Promise<AgentRecord | undefined> {
  const agent = await storesOf(opts).agents.getAgent(name)
  if (agent === undefined) {
    fail(io, `no agent "${formatReadableField(name)}": list agents with \`${cliCommand(opts.env)} agent list\``)
  }
  return agent
}

/** `--ops a,b` / `--ops none` → ops in canonical order; or the one-line problem. */
export function parseOps(value: string): { ok: true; ops: readonly FileOp[] } | { ok: false; message: string } {
  if (value === 'none') return { ok: true, ops: [] }
  const words = value.split(',').map((word) => word.trim())
  const unknown = words.find((word) => !(FILE_OPS as readonly string[]).includes(word))
  if (unknown !== undefined) {
    return { ok: false, message: `unknown operation "${formatReadableField(unknown)}" in --ops: use ${OPS_EXAMPLE} or none` }
  }
  return { ok: true, ops: normalizeOps(words as FileOp[]) }
}

function parsePositionals(args: readonly string[], count: number, withOps: boolean) {
  try {
    const parsed = parseArgs({
      args: [...args],
      options: withOps ? { ops: { type: 'string' } } : {},
      allowPositionals: true,
      strict: true,
    })
    const values = parsed.values as { ops?: string }
    return parsed.positionals.length === count ? { positionals: parsed.positionals, ops: values.ops } : undefined
  } catch {
    return undefined
  }
}

export async function record(
  io: AgentCliIo,
  opts: FilesCliOptions,
  actor: RequiredAdmin,
  op: AccessOp,
  target: string,
  info: Parameters<typeof recordAccessChange>[0]['info'],
): Promise<number> {
  return recordAccessChange({ io, opts, actor, subject: 'files', op, target, info })
}

export async function runRootAdd(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const parsed = parsePositionals(args, 1, false)
  const raw = parsed?.positionals[0]
  if (raw === undefined) return fail(io, `usage: ${cliCommand(opts.env)} files root add <folder>`)
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1

  // A server of another kind named `files` is a conflict: refuse before the folder is touched.
  if ((await filesServerState(registryOf(opts))) === 'conflict') return fail(io, conflictMessage(opts.env))
  const roots = createRootsStore({ ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}) })
  const prepared = await prepareRoot(raw, (await roots.list()).map((root) => root.path))
  if (!prepared.ok) return fail(io, replaceControlChars(prepared.message))
  const registered = await registerFilesServer(registryOf(opts))
  const { added } = await roots.add(prepared.path)
  const folder = formatReadableField(prepared.path)
  if (registered.added) io.stdout.write(`registered the built-in file server as "files" (agents connect to it like any server)\n`)
  const trash = `${folder}/.mcpcut-trash`
  io.stdout.write(added ? `root added: ${folder}\n` : `${folder} is already a root\n`)
  io.stdout.write(`trash: ${trash} (${prepared.trashCreated ? 'created' : 'already present'})\n`)
  const agents = await storesOf(opts).agents.listAgents()
  io.stderr.write(grantNextStep(opts.env ?? process.env, agents, prepared.path))
  if (!added) return 0
  return record(io, opts, actor, 'add', folder, { action: 'files.root.add', path: prepared.path })
}

export async function runRootRemove(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const raw = parsePositionals(args, 1, false)?.positionals[0]
  if (raw === undefined) return fail(io, `usage: ${cliCommand(opts.env)} files root remove <folder>`)
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1

  const roots = createRootsStore({ ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}) })
  const declared = (await roots.list()).map((root) => root.path)
  const match = (await ruleKeysOf(raw)).find((key) => declared.includes(key))
  const removed = match === undefined ? { removed: false } : await roots.remove(match)
  if (match === undefined || !removed.removed) {
    return fail(io, `no root "${formatReadableField(raw)}": list roots with \`${cliCommand(opts.env)} files root list\``)
  }
  io.stdout.write(`root removed: ${formatReadableField(match)} (the folder, its files and its trash are not deleted)\n`)
  io.stderr.write(
    'Agent rules inside it stay but give nothing until it is declared again: ' +
      `${cliCommand(opts.env)} files root add ${shellArg(match)}\n`,
  )
  return record(io, opts, actor, 'remove', formatReadableField(match), { action: 'files.root.remove', path: match })
}

export async function runGrant(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const parsed = parsePositionals(args, 2, true)
  const [agentName, rawPath] = parsed?.positionals ?? []
  if (parsed === undefined || agentName === undefined || rawPath === undefined) return fail(io, FILES_USAGE.trimEnd())
  if (parsed.ops === undefined) {
    return fail(io, `--ops is required, e.g. \`${cliCommand(opts.env)} files grant ${shellArg(agentName)} ${shellArg(rawPath)} --ops read\` (or --ops none to cut a folder out)`)
  }
  const ops = parseOps(parsed.ops)
  if (!ops.ok) return fail(io, ops.message)
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1
  if ((await findAgent(io, opts, agentName)) === undefined) return 1
  const state = await filesServerState(registryOf(opts))
  if (state === 'conflict') return fail(io, conflictMessage(opts.env))
  if (state === 'missing') return fail(io, notRegisteredMessage(opts.env, shellArg(rawPath)))

  const roots = await createRootsStore({ ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}) }).list()
  const resolved = await resolveRulePath(roots.map((root) => root.path), rawPath, (folder) => `${cliCommand(opts.env)} files root add ${shellArg(folder)}`)
  if (!resolved.ok) return fail(io, replaceControlChars(resolved.message))
  const rule = { path: resolved.path, ops: normalizeOps(ops.ops) }

  const agent = await storesOf(opts).agents.setServerGrant(agentName, FILES_SERVER_NAME, (current) => {
    const applied = applyRule(filesGrantsOf(current), rule)
    if (!applied.ok) throw new RuleRefusedError(applied.message)
    return applied.grants[FILES_SERVER_NAME] as AgentGrant
  })
  const grant = agent.grants[FILES_SERVER_NAME] as AgentGrant
  io.stdout.write(`granted ${formatReadableField(agentName)} on ${formatReadableField(rule.path)}: ${rule.ops.length === 0 ? 'no access (cut out)' : rule.ops.join(', ')}\n`)
  io.stdout.write(`${agentName}'s folder rules:\n${formatRuleLines(grant.paths ?? []).join('\n')}\n`)
  io.stderr.write(`Check the result: ${cliCommand(opts.env)} files show ${shellArg(agentName)}\n`)
  return record(io, opts, actor, 'grant', pairTarget(agentName, rule.path), {
    action: 'files.grant',
    agent: agentName,
    server: FILES_SERVER_NAME,
    path: rule.path,
    grant,
  })
}

export async function runRevoke(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const [agentName, rawPath] = parsePositionals(args, 2, false)?.positionals ?? []
  if (agentName === undefined || rawPath === undefined) return fail(io, FILES_USAGE.trimEnd())
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1
  const agent = await findAgent(io, opts, agentName)
  if (agent === undefined) return 1

  const keys = await ruleKeysOf(rawPath)
  if (!dropRule(filesGrantsOf(agent.grants[FILES_SERVER_NAME]), keys).removed) {
    return fail(io, `${formatReadableField(agentName)} has no rule for ${formatReadableField(rawPath)}: see its rules with \`${cliCommand(opts.env)} files show ${shellArg(agentName)}\``)
  }
  const updated = await storesOf(opts).agents.setServerGrant(agentName, FILES_SERVER_NAME, (current) => {
    const dropped = dropRule(filesGrantsOf(current), keys)
    if (!dropped.removed) throw new RuleRefusedError('the rule was removed meanwhile: run files show to see the current rules')
    return dropped.grants[FILES_SERVER_NAME] as AgentGrant
  })
  const grant = updated.grants[FILES_SERVER_NAME] as AgentGrant
  io.stdout.write(`revoked ${formatReadableField(keys[0] ?? rawPath)} from ${formatReadableField(agentName)}\n`)
  if (grant.paths === undefined) {
    io.stdout.write(`${formatReadableField(agentName)} now has no file access\n`)
  } else {
    io.stdout.write(`${agentName}'s folder rules:\n${formatRuleLines(grant.paths).join('\n')}\n`)
  }
  io.stderr.write(`Give a folder again: ${cliCommand(opts.env)} files grant ${shellArg(agentName)} ${shellArg(keys[0] ?? rawPath)} --ops read\n`)
  return record(io, opts, actor, 'revoke', pairTarget(agentName, keys[0] ?? rawPath), {
    action: 'files.revoke',
    agent: agentName,
    server: FILES_SERVER_NAME,
    path: keys[0] ?? rawPath,
    grant,
  })
}
