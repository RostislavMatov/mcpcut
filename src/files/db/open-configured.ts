import { formatReadableField } from '../../journal/format.js'
import { openFilesDb, type FilesDb } from './connection.js'
import { parseDbUrl, readDbUrl } from './db-url.js'
import { FilesDbModuleMissingError, loadPg, modulesDirOf, moduleMissingMessage } from './pg-loader.js'
import type { PgModule } from './pg-types.js'
import { resolveSchema } from './schema-env.js'

/**
 * The configured database for callers that must never fail because of it
 * (the audit source, the `serve` sync): Postgres mode off, unavailable with
 * a one-line reason, or open. Mode is on exactly when the vault holds the URL;
 * a vault that was never created cannot hold it, so that reads as off.
 */

export interface OpenConfiguredOptions {
  readonly journalDir: string
  readonly cli: string
  readonly env?: NodeJS.ProcessEnv
  /** Test seams. */
  readonly loadPg?: (modulesDir: string) => Promise<PgModule>
  readonly schema?: string
  readonly onOpen?: (db: FilesDb) => void
}

export type ConfiguredDb =
  | { readonly kind: 'off' }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'ready'; readonly db: FilesDb }

function describeFailure(error: unknown, cli: string): string {
  if (error instanceof FilesDbModuleMissingError) return moduleMissingMessage(cli)
  return formatReadableField(error instanceof Error ? error.message : String(error))
}

export async function openConfiguredDb(opts: OpenConfiguredOptions): Promise<ConfiguredDb> {
  try {
    const state = await readDbUrl({ journalDir: opts.journalDir, cli: opts.cli })
    if (state.status === 'off') return { kind: 'off' }
    if (state.status === 'vault-error') {
      // No vault at all means Postgres was never turned on.
      return state.message.startsWith('the vault is not initialized') ? { kind: 'off' } : { kind: 'unavailable', reason: formatReadableField(state.message) }
    }
    const parsed = parseDbUrl(state.url, opts.cli)
    if (!parsed.ok) return { kind: 'unavailable', reason: parsed.message }
    const pg = await (opts.loadPg ?? loadPg)(modulesDirOf(opts.journalDir))
    const schema = resolveSchema({ schema: opts.schema, env: opts.env })
    const db = await openFilesDb({ pg, url: state.url, schema, cli: opts.cli })
    opts.onOpen?.(db)
    return { kind: 'ready', db }
  } catch (error: unknown) {
    return { kind: 'unavailable', reason: describeFailure(error, opts.cli) }
  }
}
