import { createRootsStore } from '../files/roots-store.js'
import { syncOnce } from '../files/db/sync.js'
import type { RootWalk } from '../files/db/catalog-walk.js'
import { formatReadableField } from '../journal/format.js'
import type { AgentCliIo } from './agent-cmd.js'
import { journalDirOf, openTarget, resolveTarget } from './files-cmd-db-shared.js'
import type { FilesCliOptions } from './files-cmd.js'
import { cliCommand, shellArg } from './next-step.js'

/**
 * `mcpcut files db sync` (ADR-0020 §6): the journal into `file_events` with no
 * time budget, the catalog paths the new writes touched, then a full walk of
 * every declared root. Read-only for mcpcut's own state, so no token.
 */

function walkLine(walk: RootWalk): string {
  const root = formatReadableField(walk.root)
  if (walk.error !== undefined) return `${root}  error: ${formatReadableField(walk.error)}`
  const notes = [
    ...(walk.truncated ? ['stopped at the entry limit, nothing deleted'] : []),
    ...(walk.unreadable > 0 ? [`${walk.unreadable} folder(s) unreadable, nothing deleted`] : []),
  ]
  const counts = `${walk.files} files, ${walk.dirs} folders  +${walk.added} ~${walk.changed} -${walk.removed}`
  return [`${root}  ${counts}`, ...notes].join('  ')
}

function nextStepOf(walks: readonly RootWalk[], roots: readonly string[], cli: string): string {
  const failed = walks.find((walk) => walk.error !== undefined)
  if (failed !== undefined) return `Fix or remove the folder ${shellArg(failed.root)}: ${cli} files root remove ${shellArg(failed.root)}, then ${cli} files db sync`
  const first = roots[0]
  return first === undefined ? `Declare a folder first: ${cli} files root add <folder>` : `Next: ${cli} files audit --path ${shellArg(first)}`
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
  try {
    const { ingest, walks } = await syncOnce(db, {
      journalDir,
      roots,
      platform: process.platform,
      now: (opts.clock ?? (() => new Date()))(),
      withWalk: true,
    })
    io.stdout.write(`events: +${ingest.added} (synced through record ${ingest.lastSeq})\n`)
    walks.forEach((walk) => io.stdout.write(`${walkLine(walk)}\n`))
    io.stderr.write(`${nextStepOf(walks, roots, cli)}\n`)
    return walks.some((walk) => walk.error !== undefined) ? 1 : 0
  } finally {
    await db.close()
  }
}
