import { openFilesDb, type FilesDb } from '../files/db/connection.js'
import { readDbUrl, parseDbUrl } from '../files/db/db-url.js'
import { FilesDbModuleMissingError, loadPg, modulesDirOf, moduleMissingMessage } from '../files/db/pg-loader.js'
import type { PgModule } from '../files/db/pg-types.js'
import { resolveSchema } from '../files/db/schema-env.js'
import { JOURNAL_DIR } from '../config.js'
import { formatReadableField } from '../journal/format.js'
import type { FilesCliOptions } from './files-cmd.js'
import { cliCommand } from './next-step.js'

/** What every `files db …` command needs first: the client, the URL and the schema, or the one line saying why not. */

export interface DbTarget {
  readonly pg: PgModule
  readonly url: string
  readonly schema: string
  readonly cli: string
}

export type DbTargetResult =
  | { readonly kind: 'ready'; readonly target: DbTarget }
  | { readonly kind: 'off'; readonly pg: PgModule }
  | { readonly kind: 'refused'; readonly line: string }

export function journalDirOf(opts: FilesCliOptions): string {
  return opts.journalDir ?? JOURNAL_DIR
}

export function schemaOf(opts: FilesCliOptions): string {
  return resolveSchema({ schema: opts.db?.schema, env: opts.env })
}

/** The client, or the missing-client line. Never throws for a missing client. */
export async function loadClient(opts: FilesCliOptions): Promise<{ pg: PgModule } | { line: string }> {
  try {
    return { pg: await (opts.db?.loadPg ?? loadPg)(modulesDirOf(journalDirOf(opts))) }
  } catch (error: unknown) {
    if (error instanceof FilesDbModuleMissingError) return { line: moduleMissingMessage(cliCommand(opts.env)) }
    return { line: formatReadableField(error instanceof Error ? error.message : String(error)) }
  }
}

/** Client first (so the order of steps is always setup → init), then the vault URL. */
export async function resolveTarget(opts: FilesCliOptions): Promise<DbTargetResult> {
  const cli = cliCommand(opts.env)
  const client = await loadClient(opts)
  if ('line' in client) return { kind: 'refused', line: client.line }
  const state = await readDbUrl({ journalDir: journalDirOf(opts), cli })
  if (state.status === 'vault-error') return { kind: 'refused', line: formatReadableField(state.message) }
  if (state.status === 'off') return { kind: 'off', pg: client.pg }
  const parsed = parseDbUrl(state.url, cli)
  if (!parsed.ok) return { kind: 'refused', line: parsed.message }
  return { kind: 'ready', target: { pg: client.pg, url: state.url, schema: schemaOf(opts), cli } }
}

export async function openTarget(target: DbTarget, opts: FilesCliOptions): Promise<FilesDb> {
  const db = await openFilesDb({ pg: target.pg, url: target.url, schema: target.schema, cli: target.cli })
  opts.db?.onOpen?.(db)
  return db
}
