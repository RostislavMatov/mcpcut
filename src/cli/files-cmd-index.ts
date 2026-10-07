import { stat } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { JOURNAL_DIR } from '../config.js'
import { canonicalDataDir, overlapMessage, overlapsDataDir } from '../files/data-overlap.js'
import { adminMessage, resolveAsAdmin, ruleKeysOf } from '../files/grant-admin.js'
import { readDbUrl } from '../files/db/db-url.js'
import { modulesDirOf } from '../files/db/pg-loader.js'
import { createRootsStore } from '../files/roots-store.js'
import { createIndexRulesStore, type IndexRule } from '../files/search/index-rules-store.js'
import { isIndexed, skippedSegmentOf } from '../files/search/index-scope.js'
import { searchRuntimeProblem } from '../files/search/readiness.js'
import { formatReadableField, replaceControlChars } from '../journal/format.js'
import type { AgentCliIo } from './agent-cmd.js'
import { FILES_USAGE } from './files-cmd-format.js'
import { runIndexList } from './files-cmd-index-list.js'
import type { FilesCliOptions } from './files-cmd.js'
import { fail, record, requireOwner } from './files-cmd-write.js'
import { cliCommand, shellArg } from './next-step.js'

/**
 * `mcpcut files index on|off|list` (ADR-0020 §6): which folders are embedded
 * for search by meaning. A rule covers the folder and its subfolders; `off` on
 * a subfolder of an indexed folder cuts it out. `on` and `off` need an owner
 * token and leave an audit line plus an `access-edit` record; `list` is free.
 */

function journalDirOf(opts: FilesCliOptions): string {
  return opts.journalDir ?? JOURNAL_DIR
}

export function indexRulesStoreOf(opts: FilesCliOptions) {
  return createIndexRulesStore({ journalDir: journalDirOf(opts), ...(opts.clock !== undefined ? { clock: opts.clock } : {}) })
}

function oneFolder(args: readonly string[]): string | undefined {
  try {
    const parsed = parseArgs({ args: [...args], options: {}, allowPositionals: true, strict: true })
    return parsed.positionals.length === 1 ? parsed.positionals[0] : undefined
  } catch {
    return undefined
  }
}

export async function runIndex(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const [action, ...rest] = args
  if (action === 'on') return runIndexOn(rest, io, opts)
  if (action === 'off') return runIndexOff(rest, io, opts)
  if (action === 'list' && rest.length === 0) return runIndexList(io, opts)
  io.stderr.write(FILES_USAGE)
  return 1
}

type Folder = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly line: string }

/** The folder as an index rule path: canonical, inside a declared root, a real directory, outside mcpcut's data. */
async function resolveFolder(raw: string, roots: readonly string[], opts: FilesCliOptions): Promise<Folder> {
  const cli = cliCommand(opts.env)
  const resolved = await resolveAsAdmin(raw, roots)
  if (!resolved.ok) {
    const label = formatReadableField(raw)
    const line =
      resolved.refusal === 'outside-roots'
        ? `${label} is not inside a declared root: run \`${cli} files root add ${shellArg(raw)}\` first`
        : adminMessage(resolved.refusal, label, roots, `${cli} files root add ${shellArg(raw)}`)
    return { ok: false, line: replaceControlChars(line) }
  }
  const folder = resolved.path.absolute
  const info = await stat(folder).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    return { ok: false, line: `${formatReadableField(folder)} is not a folder that exists: pass a folder inside a declared root` }
  }
  const dataDir = await canonicalDataDir(journalDirOf(opts))
  if (overlapsDataDir(folder, dataDir)) return { ok: false, line: overlapMessage(formatReadableField(folder), formatReadableField(dataDir)) }
  const skipped = skippedSegmentOf(folder)
  if (skipped !== null) {
    return { ok: false, line: `${formatReadableField(folder)} lies in ${formatReadableField(skipped)}, which is never indexed: choose another folder (${cli} files index on <folder>)` }
  }
  return { ok: true, path: folder }
}

/** Where the first missing piece of the chain is: Postgres, then the runtime and the model, then the sync. */
async function nextAfterOn(opts: FilesCliOptions): Promise<string> {
  const cli = cliCommand(opts.env)
  const journalDir = journalDirOf(opts)
  const state = await readDbUrl({ journalDir, cli })
  if (state.status !== 'on') return `Next: ${cli} files db init`
  const problem = await (opts.db?.searchProblem ?? searchRuntimeProblem)(modulesDirOf(journalDir), cli)
  if (problem !== null) return `Next: ${cli} files setup --search`
  return `Next: ${cli} files db sync  (${cli} serve keeps it current)`
}

export async function runIndexOn(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const raw = oneFolder(args)
  if (raw === undefined) return fail(io, `usage: ${cliCommand(opts.env)} files index on <folder>`)
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1
  const roots = (await createRootsStore({ journalDir: journalDirOf(opts) }).list()).map((root) => root.path)
  const folder = await resolveFolder(raw, roots, opts)
  if (!folder.ok) return fail(io, folder.line)
  await indexRulesStoreOf(opts).set(folder.path, true)
  const label = formatReadableField(folder.path)
  io.stdout.write(`search index: on for ${label} and its subfolders\n`)
  io.stderr.write(`${await nextAfterOn(opts)}\n`)
  return record(io, opts, actor, 'set', label, { action: 'files.index.on', path: folder.path }, 'index on')
}

/** The rule this folder names (canonical or as typed) and whether a wider rule would still index it. */
async function ruleStateOf(raw: string, rules: readonly IndexRule[]): Promise<{ target: string; existing: IndexRule | undefined; isCovered: boolean }> {
  const keys = await ruleKeysOf(raw)
  const existing = rules.find((rule) => keys.includes(rule.path))
  const target = existing?.path ?? keys[0] ?? raw
  const others = rules.filter((rule) => rule.path !== target)
  return { target, existing, isCovered: isIndexed(target, others, process.platform) }
}

export async function runIndexOff(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const cli = cliCommand(opts.env)
  const raw = oneFolder(args)
  if (raw === undefined) return fail(io, `usage: ${cli} files index off <folder>`)
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1
  const store = indexRulesStoreOf(opts)
  const { target, existing, isCovered } = await ruleStateOf(raw, await store.list())
  const label = formatReadableField(target)
  const listStep = `Next: ${cli} files index list`
  if (!isCovered && existing === undefined) {
    io.stdout.write(`${label} is not indexed\n`)
    io.stderr.write(`${listStep}\n`)
    return 0
  }
  if (isCovered && existing?.enabled === false) {
    io.stdout.write(`${label} is already cut out of the index\n`)
    io.stderr.write(`${listStep}\n`)
    return 0
  }
  if (isCovered) {
    await store.set(target, false)
    io.stdout.write(`search index: ${label} cut out of the index (its parent folder stays indexed)\n`)
  } else {
    await store.remove(target)
    io.stdout.write(`search index: off for ${label}\n`)
  }
  io.stderr.write(`${listStep}  (the next sync drops its files from the index)\n`)
  return record(io, opts, actor, isCovered ? 'set' : 'remove', label, { action: 'files.index.off', path: target }, 'index off')
}
