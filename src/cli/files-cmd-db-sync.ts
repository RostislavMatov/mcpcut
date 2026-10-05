import { createRootsStore } from '../files/roots-store.js'
import { syncOnce } from '../files/db/sync.js'
import type { RootWalk } from '../files/db/catalog-walk.js'
import { formatReadableField } from '../journal/format.js'
import type { AgentCliIo } from './agent-cmd.js'
import { journalDirOf, openTarget, resolveTarget } from './files-cmd-db-shared.js'
import type { FilesCliOptions } from './files-cmd.js'
import { openIndexSync, reportIndexOutcome, type IndexSyncReport } from './files-cmd-db-sync-index.js'
import { cliCommand, shellArg } from './next-step.js'

/**
 * `mcpcut files db sync` (ADR-0020 §6): the journal into `file_events` with no
 * time budget, the catalog paths the new writes touched, then a full walk of
 * every declared root. Read-only for mcpcut's own state, so no token.
 */

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function walkLine(walk: RootWalk): string {
  const root = formatReadableField(walk.root)
  if (walk.error !== undefined) return `${root}  error: ${formatReadableField(walk.error)}`
  const notes = [
    ...(walk.truncated ? ['stopped at the entry limit, nothing deleted'] : []),
    ...(walk.skipped > 0 ? [`${walk.skipped} path(s) longer than 600 characters skipped`] : []),
    ...(walk.hashDeferred > 0 ? [`${walk.hashDeferred} file(s) hashed by the next sync`] : []),
    ...(walk.unreadable > 0 ? [`${walk.unreadable} folder(s) unreadable, nothing deleted`] : []),
  ]
  const counts = `${countOf(walk.files, 'file')}, ${countOf(walk.dirs, 'folder')}  +${walk.added} ~${walk.changed} -${walk.removed}`
  return [`${root}  ${counts}`, ...notes].join('  ')
}

function nextStepOf(walks: readonly RootWalk[], roots: readonly string[], cli: string): string {
  const failed = walks.find((walk) => walk.error !== undefined)
  if (failed !== undefined) return `Fix or remove the folder ${shellArg(failed.root)}: ${cli} files root remove ${shellArg(failed.root)}, then ${cli} files db sync`
  const first = roots[0]
  return first === undefined ? `Declare a folder first: ${cli} files root add <folder>` : `Next: ${cli} files audit --path ${shellArg(first)}`
}

function nextAfterIndex(report: IndexSyncReport, walks: readonly RootWalk[], roots: readonly string[], cli: string): string {
  if (report.problem !== undefined) return `Fix that, then run it again: ${cli} files db sync`
  return report.next ?? nextStepOf(walks, roots, cli)
}

export async function runDbSync(io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const cli = cliCommand(opts.env)
  const resolved = await resolveTarget(opts)
  if (resolved.kind === 'refused') {
    io.stderr.write(`${resolved.line}\n`)
    return 1
  }
  if (resolved.kind === 'off') {
    io.stderr.write(`Postgres is not turned on: run \`${cli} files db init\`\n`)
    return 1
  }
  const journalDir = journalDirOf(opts)
  const roots = (await createRootsStore({ journalDir }).list()).map((root) => root.path)
  const db = await openTarget(resolved.target, opts)
  const indexSync = await openIndexSync(opts, journalDir, (line) => io.stdout.write(line))
  try {
    const { ingest, walks, index } = await syncOnce(db, {
      journalDir,
      roots,
      platform: process.platform,
      now: (opts.clock ?? (() => new Date()))(),
      withWalk: true,
      index: indexSync.options,
    })
    io.stdout.write(`events: +${ingest.added} (synced through record ${ingest.lastSeq})\n`)
    if (ingest.skipped > 0) {
      io.stdout.write(`${countOf(ingest.skipped, 'record')} could not be indexed; they are still in the journal: ${cli} files audit\n`)
    }
    walks.forEach((walk) => io.stdout.write(`${walkLine(walk)}\n`))
    const report = reportIndexOutcome(index, cli)
    report.lines.forEach((line) => io.stdout.write(`${line}\n`))
    const hasWalkError = walks.some((walk) => walk.error !== undefined)
    if (report.problem !== undefined) io.stderr.write(`${report.problem}\n`)
    const next = hasWalkError ? nextStepOf(walks, roots, cli) : nextAfterIndex(report, walks, roots, cli)
    io.stderr.write(`${next}\n`)
    return hasWalkError || report.problem !== undefined ? 1 : 0
  } finally {
    await indexSync.close()
    await db.close()
  }
}
