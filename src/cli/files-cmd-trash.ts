import path from 'node:path'
import { parseArgs } from 'node:util'
import { MAX_PURGE_DAYS, MS_PER_DAY, TRASH_RETENTION_DAYS } from '../files/constants.js'
import { ruleKeysOf } from '../files/grant-admin.js'
import { listTrash, purgeTrash, restoreFromTrash, type SkippedEntry } from '../files/io-trash-admin.js'
import { createRootsStore } from '../files/roots-store.js'
import type { TrashManifest } from '../files/trash-manifest.js'
import { formatReadableField } from '../journal/format.js'
import type { AdminRefusalWording, RequiredAdmin } from './admin-token.js'
import { recordAccessChange, requireAccessOwner } from './access-cmd-write.js'
import type { AgentCliIo } from './agent-cmd.js'
import type { FilesCliOptions } from './files-cmd.js'
import { FILES_TRASH_USAGE } from './files-cmd-format.js'
import { cliCommand, shellArg } from './next-step.js'

/**
 * `mcpcut files trash list|restore|purge` (ADR-0020 §4): the administrator's
 * side of the trash. Listing is free; restore and purge need an owner token
 * and leave an audit line plus an `access-edit` record. A root argument must
 * be a declared root, so nobody restores into or purges an arbitrary folder.
 */

const TRASH_REFUSAL: AdminRefusalWording = {
  action: 'restore or purge the file trash',
  noun: 'change',
  verb: 'may not change file rights',
  roleDetail: 'the same rule `files grant` follows',
}

const DAYS_PATTERN = /^[1-9]\d{0,3}$/

function fail(io: AgentCliIo, line: string): number {
  io.stderr.write(`${line}\n`)
  return 1
}

function storeOptions(opts: FilesCliOptions): { journalDir?: string } {
  return opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}
}

async function declaredRoots(opts: FilesCliOptions): Promise<readonly string[]> {
  return (await createRootsStore(storeOptions(opts)).list()).map((root) => root.path)
}

/** The declared root the argument names, or the one-line refusal that lists the declared ones. */
async function resolveRoot(io: AgentCliIo, opts: FilesCliOptions, raw: string): Promise<string | undefined> {
  const declared = await declaredRoots(opts)
  const cli = cliCommand(opts.env)
  const match = (await ruleKeysOf(raw)).find((key) => declared.includes(key))
  if (match !== undefined) return match
  const label = formatReadableField(raw)
  if (declared.length === 0) {
    fail(io, `no root "${label}": no roots are declared yet, add one with \`${cli} files root add <folder>\``)
  } else {
    fail(io, `no root "${label}": declared roots are ${declared.map(formatReadableField).join(', ')}`)
  }
  return undefined
}

function parseTrashArgs(args: readonly string[], withDays: boolean) {
  try {
    const parsed = parseArgs({
      args: [...args],
      options: withDays ? { 'older-than-days': { type: 'string' } } : {},
      allowPositionals: true,
      strict: true,
    })
    return { positionals: parsed.positionals, days: (parsed.values as { 'older-than-days'?: string })['older-than-days'] }
  } catch {
    return undefined
  }
}

const formatDeleted = (entry: TrashManifest): string =>
  `  ${entry.id}  ${entry.kind}  ${entry.size} B  deleted ${formatReadableField(entry.deletedAt)} by ${formatReadableField(entry.deletedBy)}  ${formatReadableField(entry.relative)}\n`

const formatSkipped = (entry: SkippedEntry): string =>
  `  skipped ${formatReadableField(entry.id)}: ${formatReadableField(entry.reason)}\n`

async function runList(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const parsed = parseTrashArgs(args, false)
  if (parsed === undefined || parsed.positionals.length > 1) return fail(io, FILES_TRASH_USAGE.trimEnd())
  const cli = cliCommand(opts.env)
  const [raw] = parsed.positionals
  const named = raw === undefined ? undefined : await resolveRoot(io, opts, raw)
  if (raw !== undefined && named === undefined) return 1
  const roots = named !== undefined ? [named] : await declaredRoots(opts)
  if (roots.length === 0) {
    io.stdout.write('(no roots)\n')
    io.stderr.write(`Add one: ${cli} files root add <folder>\n`)
    return 0
  }
  const listings = await Promise.all(roots.map(async (root) => ({ root, listing: await listTrash(root) })))
  let first: { root: string; id: string } | undefined
  let failed = false
  for (const { root, listing } of listings) {
    io.stdout.write(`${formatReadableField(root)}:\n`)
    if (!listing.ok) {
      failed = true
      io.stdout.write(`  ${formatReadableField(listing.message)}\n`)
      continue
    }
    if (listing.value.entries.length === 0 && listing.value.skipped.length === 0) io.stdout.write('  nothing is in the trash\n')
    listing.value.entries.forEach((entry) => io.stdout.write(formatDeleted(entry)))
    listing.value.skipped.forEach((entry) => io.stdout.write(formatSkipped(entry)))
    const [head] = listing.value.entries
    if (first === undefined && head !== undefined) first = { root, id: head.id }
  }
  io.stderr.write(listNextStep(cli, first, roots[0] ?? ''))
  return failed && raw !== undefined ? 1 : 0
}

function listNextStep(cli: string, first: { root: string; id: string } | undefined, root: string): string {
  if (first !== undefined) return `Restore one: ${cli} files trash restore ${shellArg(first.root)} ${shellArg(first.id)}\n`
  return (
    'Nothing to restore. Items land here when an agent with the delete right calls delete_file: ' +
    `${cli} files grant <agent> ${shellArg(root)} --ops read,write,edit,delete\n`
  )
}

async function runRestore(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const positionals = parseTrashArgs(args, false)?.positionals ?? []
  const [raw, id] = positionals
  if (raw === undefined || id === undefined || positionals.length !== 2) return fail(io, FILES_TRASH_USAGE.trimEnd())
  const actor = await requireAccessOwner(io, opts, TRASH_REFUSAL)
  if (actor === undefined) return 1
  const root = await resolveRoot(io, opts, raw)
  if (root === undefined) return 1
  const restored = await restoreFromTrash(root, id)
  if (!restored.ok) {
    const cli = cliCommand(opts.env)
    return fail(io, `${formatReadableField(restored.message)} (ids: ${cli} files trash list ${shellArg(root)})`)
  }
  const target = path.join(root, restored.value.relative)
  io.stdout.write(`restored ${formatReadableField(target)} from the trash\n`)
  io.stderr.write(`See what is left in the trash: ${cliCommand(opts.env)} files trash list ${shellArg(root)}\n`)
  return record(io, opts, actor, 'restore', formatReadableField(target), { action: 'files.trash.restore', path: target, trashId: id })
}

async function runPurge(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const parsed = parseTrashArgs(args, true)
  if (parsed === undefined && args.includes('--older-than-days')) return fail(io, daysMessage())
  const [raw] = parsed?.positionals ?? []
  if (parsed === undefined || raw === undefined || parsed.positionals.length !== 1) return fail(io, FILES_TRASH_USAGE.trimEnd())
  const days = parsed.days === undefined ? TRASH_RETENTION_DAYS : parseDays(parsed.days)
  if (days === undefined) {
    return fail(io, daysMessage())
  }
  const actor = await requireAccessOwner(io, opts, TRASH_REFUSAL)
  if (actor === undefined) return 1
  const root = await resolveRoot(io, opts, raw)
  if (root === undefined) return 1
  const result = await purgeTrash(root, days * MS_PER_DAY, (opts.clock ?? (() => new Date()))().getTime())
  if (!result.ok) return fail(io, `${formatReadableField(result.message)}`)
  const { purged, skipped } = result.value
  io.stdout.write(`purged ${purged} ${purged === 1 ? 'item' : 'items'} older than ${days} days from ${formatReadableField(root)}\n`)
  skipped.forEach((entry) => io.stdout.write(formatSkipped(entry)))
  io.stderr.write(`See what is left: ${cliCommand(opts.env)} files trash list ${shellArg(root)}\n`)
  return record(io, opts, actor, 'purge', formatReadableField(root), {
    action: 'files.trash.purge',
    path: root,
    olderThan: `${days}d`,
    deletedCount: purged,
  })
}

function daysMessage(): string {
  return `--older-than-days must be a whole number from 1 to ${MAX_PURGE_DAYS} (default ${TRASH_RETENTION_DAYS}), e.g. \`--older-than-days 7\``
}

function parseDays(value: string): number | undefined {
  if (!DAYS_PATTERN.test(value)) return undefined
  const days = Number(value)
  return days <= MAX_PURGE_DAYS ? days : undefined
}

function record(
  io: AgentCliIo,
  opts: FilesCliOptions,
  actor: RequiredAdmin,
  op: 'restore' | 'purge',
  target: string,
  info: Parameters<typeof recordAccessChange>[0]['info'],
): Promise<number> {
  return recordAccessChange({ io, opts, actor, subject: 'files', op, target, info })
}

export async function runTrash(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const [action, ...rest] = args
  if (action === 'list') return runList(rest, io, opts)
  if (action === 'restore') return runRestore(rest, io, opts)
  if (action === 'purge') return runPurge(rest, io, opts)
  io.stderr.write(FILES_TRASH_USAGE)
  return 1
}
