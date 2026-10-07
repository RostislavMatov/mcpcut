import { describeDbUrl, parseDbUrl, readDbUrl } from '../files/db/db-url.js'
import { FilesDbError } from '../files/db/errors.js'
import { modulesDirOf } from '../files/db/pg-loader.js'
import { readDbStatus, type DbStatus } from '../files/db/status.js'
import { journalBounds } from '../journal/db-read-after.js'
import { formatReadableField } from '../journal/format.js'
import type { AgentCliIo } from './agent-cmd.js'
import { installedPgVersion } from './files-cmd-setup.js'
import { writeSearchStatus } from './files-cmd-db-status-search.js'
import { journalDirOf, loadClient, schemaOf } from './files-cmd-db-shared.js'
import type { FilesCliOptions } from './files-cmd.js'
import { reportSearchCounts } from './files-cmd-db-status-index.js'
import { cliCommand } from './next-step.js'

/**
 * `mcpcut files db status`: client, URL, server, counts — one line each, then
 * the one step that fits the state found. Read-only, no token; a state that is
 * merely "not turned on yet" is exit 0, a server that cannot answer is 1.
 */

export async function runDbStatus(io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const cli = cliCommand(opts.env)
  const journalDir = journalDirOf(opts)
  const installed = await installedPgVersion(modulesDirOf(journalDir))
  io.stdout.write(`client: ${installed === undefined ? 'not installed' : `installed pg ${formatReadableField(installed)}`}\n`)

  await writeSearchStatus(io, modulesDirOf(journalDir), cli)

  const state = await readDbUrl({ journalDir, cli })
  if (state.status === 'vault-error' && state.reason === 'not-initialized') {
    io.stdout.write('url: off\n')
    const setup = installed === undefined ? `${cli} files setup, then ` : ''
    io.stderr.write(`Next: ${setup}${cli} vault init, then ${cli} files db init\n`)
    return 0
  }
  if (state.status === 'vault-error') {
    io.stdout.write('url: unknown\n')
    io.stderr.write(`${formatReadableField(state.message)}\n`)
    return 1
  }
  if (state.status === 'off') {
    io.stdout.write('url: off\n')
    io.stderr.write(installed === undefined ? `Next: ${cli} files setup\n` : `Turn it on: ${cli} files db init\n`)
    return 0
  }
  const parsed = parseDbUrl(state.url, cli)
  if (!parsed.ok) {
    io.stdout.write('url: invalid\n')
    io.stderr.write(`${parsed.message}\n`)
    return 1
  }
  io.stdout.write(`url: ${formatReadableField(describeDbUrl(state.url))}\n`)
  const client = await loadClient(opts)
  if ('line' in client) {
    io.stderr.write(`${client.line}\n`)
    return 1
  }
  return reportServer(io, opts, { pg: client.pg, url: state.url, schema: schemaOf(opts), cli })
}

async function reportServer(io: AgentCliIo, opts: FilesCliOptions, target: Parameters<typeof readDbStatus>[0]): Promise<number> {
  let status: DbStatus
  try {
    status = await readDbStatus(target)
  } catch (error: unknown) {
    if (!(error instanceof FilesDbError)) throw error
    io.stdout.write('server: unavailable\n')
    io.stderr.write(`${formatReadableField(error.message)}\n`)
    return 1
  }
  if (status.schemaVersion === null) {
    io.stdout.write(`server: reachable, schema ${target.schema} not created yet\n`)
    io.stderr.write(`Next: ${target.cli} files db init\n`)
    return 0
  }
  const { maxSeq } = await journalBounds(journalDirOf(opts))
  io.stdout.write(`server: reachable, schema ${target.schema}, version ${status.schemaVersion}\n`)
  io.stdout.write(`catalog: ${status.catalogRows} rows\n`)
  io.stdout.write(`file events: ${status.eventRows} rows, synced through record ${status.lastSeq} of ${maxSeq}\n`)
  await reportSearchCounts(io, target)
  io.stderr.write(
    status.lastSeq < maxSeq || status.catalogRows === 0
      ? `Next: ${target.cli} files db sync\n`
      : `Next: ${target.cli} files audit\n`,
  )
  return 0
}

