import { FilesDbError } from '../files/db/errors.js'
import { readSearchTotals, type SearchTarget } from '../files/search/index-counts.js'
import { formatReadableField } from '../journal/format.js'
import type { AgentCliIo } from './agent-cmd.js'

/**
 * The index counts block of `files db status`: one line, printed only when
 * the database has the search tables (a database that never used search
 * shows nothing new). Never throws for a database problem: the line says so.
 */
export async function reportSearchCounts(io: AgentCliIo, target: SearchTarget): Promise<void> {
  try {
    const totals = await readSearchTotals(target)
    if (totals === undefined) return
    const last = totals.lastIndexedAt === null ? 'nothing indexed yet' : `last indexed ${formatReadableField(totals.lastIndexedAt)}`
    io.stdout.write(`search index: ${totals.indexed} files indexed (${totals.chunks} chunks), ${totals.skipped} skipped${totals.failed > 0 ? `, ${totals.failed} failed (retried when the file changes or in an hour)` : ''}, ${last}\n`)
  } catch (error: unknown) {
    if (!(error instanceof FilesDbError)) throw error
    io.stdout.write(`search index: unavailable (${formatReadableField(error.message)})\n`)
  }
}
