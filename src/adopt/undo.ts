import { errnoCodeOf } from '../errno.js'
import type { FileProblem, WrittenFile } from './apply.js'
import { readConfigFile, renderLike, replaceFileAtomically } from './files.js'
import { latestActiveManifest, writeManifest, type ManifestChange } from './manifest.js'
import { commandLineOf, serversAt, withEntries, type CommandLine } from './plan.js'

/**
 * `mcpcut adopt --undo` (P3): put back the command lines the newest
 * not-undone `--apply` wrote, entry by entry. An entry is restored only while
 * it still holds exactly the command line adopt wrote — whatever the user
 * changed since (a new env key, a hand edit, a removed server) wins. Undo is
 * a stack: each call reaches one run further back.
 */

export interface UndoOptions {
  readonly dataDir: string
  readonly now?: () => Date
}

export interface KeptEntry {
  readonly file: string
  readonly name: string
}

export type UndoResult =
  | { readonly kind: 'nothing' }
  | { readonly kind: 'problem'; readonly dir: string; readonly reason: string }
  | {
      readonly kind: 'done'
      readonly dir: string
      readonly restored: readonly WrittenFile[]
      /** Entries changed or removed since adopt; left as the user has them. */
      readonly kept: readonly KeptEntry[]
      readonly failures: readonly FileProblem[]
    }

type Entry = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameCommandLine(a: CommandLine, b: CommandLine): boolean {
  return a.command === b.command && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? [])
}

/** The entry with its command line put back, every other key where it was. */
function restored(entry: Entry, before: CommandLine): Entry {
  const withoutArgs = Object.entries(entry).filter(([key]) => key !== 'args' || before.args !== undefined)
  return Object.fromEntries(withoutArgs.map(([key, value]) => [key, key === 'command' ? before.command : key === 'args' ? before.args : value]))
}

function entryAt(doc: unknown, change: ManifestChange): Entry | undefined {
  const entry = serversAt(doc, change.path)?.[change.name]
  return isRecord(entry) && sameCommandLine(commandLineOf(entry), change.after) ? entry : undefined
}

interface FileUndo {
  readonly restored?: WrittenFile
  readonly kept: readonly KeptEntry[]
  readonly failure?: FileProblem
}

async function undoFile(file: string, changes: readonly ManifestChange[]): Promise<FileUndo> {
  const state = await readConfigFile(file)
  const keptAll = changes.map((change) => ({ file, name: change.name }))
  if (state.kind === 'missing') return { kept: keptAll }
  if (state.kind === 'problem') return { kept: keptAll, failure: { file, reason: state.reason } }
  const matching = changes.flatMap((change) => {
    const entry = entryAt(state.doc, change)
    return entry === undefined ? [] : [{ change, entry }]
  })
  const kept = changes.filter((change) => !matching.some((m) => m.change === change)).map((change) => ({ file, name: change.name }))
  if (matching.length === 0) return { kept }
  const next = matching.reduce((doc, { change, entry }) => withEntries(doc, change.path, { [change.name]: restored(entry, change.before) }), state.doc)
  try {
    await replaceFileAtomically(file, renderLike(state.text, next))
  } catch (error) {
    return { kept: keptAll, failure: { file, reason: `could not write it (${errnoCodeOf(error) ?? String(error)})` } }
  }
  return { restored: { file, servers: matching.map((m) => m.change.name) }, kept }
}

export async function undoAdopt(opts: UndoOptions): Promise<UndoResult> {
  const latest = await latestActiveManifest(opts.dataDir)
  if (latest.kind !== 'found') return latest
  const files = [...new Set(latest.manifest.changes.map((change) => change.file))]
  const outcomes: FileUndo[] = []
  for (const file of files) {
    outcomes.push(await undoFile(file, latest.manifest.changes.filter((change) => change.file === file)))
  }
  const failures = outcomes.flatMap((o) => (o.failure === undefined ? [] : [o.failure]))
  // A file that could not be written keeps the run open: the next `--undo` retries it.
  if (failures.length === 0) {
    const undoneAt = (opts.now ?? (() => new Date()))().toISOString()
    await writeManifest(latest.dir, { ...latest.manifest, undoneAt })
  }
  return {
    kind: 'done',
    dir: latest.dir,
    restored: outcomes.flatMap((o) => (o.restored === undefined ? [] : [o.restored])),
    kept: outcomes.flatMap((o) => o.kept),
    failures,
  }
}
