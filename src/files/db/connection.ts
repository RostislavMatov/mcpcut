import {
  APPLICATION_NAME,
  CONNECT_TIMEOUT_MS,
  DEFAULT_DB_SCHEMA,
  POOL_MAX,
  STATEMENT_TIMEOUT_MS,
} from './constants.js'
import { mapPgError } from './errors.js'
import { assertSchemaName, migrate } from './migrate.js'
import { MIGRATIONS, type Migration } from './migrations.js'
import type { PgModule, PgPool, PgQueryable, PgQueryResult } from './pg-types.js'

/**
 * The open database: a pool pinned to the mcpcut schema, migrated to the
 * newest version. Every error leaves here already mapped (`errors.ts`).
 */
export interface FilesDb {
  readonly schema: string
  readonly schemaVersion: number
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>>
  /** One transaction on a dedicated client; rolled back when `fn` throws. */
  transaction<T>(fn: (tx: PgQueryable) => Promise<T>): Promise<T>
  close(): Promise<void>
  /**
   * A dedicated client with no transaction opened, for session state such as an advisory lock; released
   * (destroyed when `fn` throws) afterwards. Appended for search by meaning (phase 5).
   */
  withClient<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T>
}

export interface OpenFilesDbOptions {
  readonly pg: PgModule
  readonly url: string
  readonly schema?: string
  /** Receives idle-client errors so they never crash the process. */
  readonly onError?: (error: Error) => void
  /** The CLI prefix for the next steps inside error messages. */
  readonly cli?: string
  /** @internal test seam: a different migration list. */
  readonly migrations?: readonly Migration[]
}

/** A pool pinned to `schema` on the given server; the schema need not exist yet. */
export function createPool(pg: PgModule, url: string, schema: string, onError?: (error: Error) => void): PgPool {
  assertSchemaName(schema)
  const pool: PgPool = new pg.Pool({
    connectionString: url,
    max: POOL_MAX,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    application_name: APPLICATION_NAME,
    options: `-c search_path=${schema}`,
  })
  pool.on('error', onError ?? (() => undefined))
  return pool
}

export async function openFilesDb(opts: OpenFilesDbOptions): Promise<FilesDb> {
  const schema = opts.schema ?? DEFAULT_DB_SCHEMA
  const ctx = { url: opts.url, schema, cli: opts.cli ?? 'mcpcut' }
  const pool = createPool(opts.pg, opts.url, schema, opts.onError)
  try {
    const schemaVersion = await migrate(pool, schema, opts.migrations ?? MIGRATIONS)
    return dbOver(pool, schema, schemaVersion, (error) => mapPgError(error, ctx))
  } catch (error: unknown) {
    await pool.end().catch(() => undefined)
    throw mapPgError(error, ctx)
  }
}

function dbOver(pool: PgPool, schema: string, schemaVersion: number, mapError: (error: unknown) => Error): FilesDb {
  const db: FilesDb = {
    schema,
    schemaVersion,
    async query<Row>(text: string, values?: readonly unknown[]) {
      try {
        return await pool.query<Row>(text, values)
      } catch (error: unknown) {
        throw mapError(error)
      }
    },
    async transaction<T>(fn: (tx: PgQueryable) => Promise<T>) {
      return db.withClient(async (tx) => {
        try {
          await tx.query('BEGIN')
          const result = await fn(tx)
          await tx.query('COMMIT')
          return result
        } catch (error: unknown) {
          await tx.query('ROLLBACK').catch(() => undefined)
          throw error
        }
      })
    },
    async withClient<T>(fn: (client: PgQueryable) => Promise<T>) {
      const client = await pool.connect().catch((error: unknown) => {
        throw mapError(error)
      })
      const mapped: PgQueryable = {
        query: async <Row>(text: string, values?: readonly unknown[]) => {
          try {
            return await client.query<Row>(text, values)
          } catch (error: unknown) {
            throw mapError(error)
          }
        },
      }
      let failure: Error | undefined
      try {
        return await fn(mapped)
      } catch (error: unknown) {
        failure = error instanceof Error ? error : new Error(String(error))
        throw error
      } finally {
        client.release(failure)
      }
    },
    async close() {
      await pool.end()
    },
  }
  return db
}
