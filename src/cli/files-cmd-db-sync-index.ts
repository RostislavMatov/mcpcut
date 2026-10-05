import type { SyncIndexOptions, SyncIndexOutcome } from '../files/db/sync.js'
import { createLocalEmbedder } from '../files/search/embedder.js'
import { createIndexRulesStore } from '../files/search/index-rules-store.js'
import type { Embedder } from '../files/search/types.js'
import { formatReadableField } from '../journal/format.js'
import type { FilesCliOptions } from './files-cmd.js'
import { cliCommand } from './next-step.js'
import { modulesDirOf } from '../files/db/pg-loader.js'

/** The search-index half of `files db sync`: the options it hands `syncOnce`, and how the outcome is printed. */

const PROGRESS_EVERY = 50

export interface IndexSyncHandle {
  /** Always present: with no rule on, the sync only clears what an earlier rule left (nothing, and no output, if search was never used). */
  readonly options: SyncIndexOptions
  /** Closes the embedder if one was made. */
  close(): Promise<void>
}

export async function openIndexSync(opts: FilesCliOptions, journalDir: string, write: (line: string) => void): Promise<IndexSyncHandle> {
  const rules = await createIndexRulesStore({ journalDir }).list()
  const make = opts.db?.indexEmbedder ?? ((modulesDir: string) => createLocalEmbedder({ modulesDir }))
  let embedder: Embedder | undefined
  return {
    options: {
      rules,
      embedder: async () => (embedder ??= await make(modulesDirOf(journalDir))),
      budgetMs: Number.POSITIVE_INFINITY,
      cli: cliCommand(opts.env),
      onProgress: (done, total) => {
        if (done % PROGRESS_EVERY === 0 && done < total) write(`indexing: ${done} of ${total} files\n`)
      },
    },
    close: async () => void (await embedder?.close().catch(() => undefined)),
  }
}

function reasonsOf(byReason: Readonly<Record<string, number>>): string {
  const parts = Object.entries(byReason)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([reason, count]) => `${count} ${reason}`)
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`
}

export interface IndexSyncReport {
  readonly lines: readonly string[]
  /** A step that left the index not current: exit 1. */
  readonly problem: string | undefined
  /** What to do next, or `undefined` to keep the sync's own next step. */
  readonly next: string | undefined
}

export function reportIndexOutcome(outcome: SyncIndexOutcome | undefined, cli: string): IndexSyncReport {
  if (outcome === undefined) return { lines: [], problem: undefined, next: undefined }
  if (outcome.problem !== undefined) {
    return { lines: [], problem: `search index: not updated: ${formatReadableField(outcome.problem)}`, next: undefined }
  }
  const result = outcome.result
  if (result === undefined) return { lines: [], problem: undefined, next: undefined }
  const list = `Next: ${cli} files index list`
  if (result.busy === true) {
    return { lines: ['search index: another process is indexing right now'], problem: undefined, next: `Run it again in a minute: ${cli} files db sync` }
  }
  const lines = [
    `search index: ${result.indexed} files indexed, ${result.skipped} skipped${reasonsOf(result.skippedByReason)}, ${result.pending} pending, ${result.failed} failed` +
      (result.removed > 0 ? `, ${result.removed} removed` : ''),
    ...(result.firstFailure === undefined ? [] : [`first failure: ${formatReadableField(result.firstFailure)}`]),
  ]
  const isIncomplete = result.pending > 0 || result.failed > 0
  return { lines, problem: undefined, next: isIncomplete ? `Finish the index: ${cli} files db sync (then ${cli} files index list)` : list }
}
