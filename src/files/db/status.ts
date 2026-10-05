import { createPool } from './connection.js'
import { mapPgError } from './errors.js'
import type { PgModule } from './pg-types.js'

/** What `files db status` reports about a reachable server. Reads only: it never migrates. */
export interface DbStatus {
  /** `null` when the mcpcut schema has not been created yet. */
  readonly schemaVersion: number | null
  readonly catalogRows: number
  readonly eventRows: number
  /** The journal `seq` the index has been filled through. */
  readonly lastSeq: number
}

export interface ReadDbStatusOptions {
  readonly pg: PgModule
  readonly url: string
  readonly schema: string
  readonly cli: string
}

interface CountRow {
  readonly catalog: string
  readonly events: string
  readonly last_seq: string
}

const SELECT_HAS_MIGRATIONS = "SELECT to_regclass('schema_migrations') IS NOT NULL AS present"
const SELECT_VERSION = 'SELECT max(version) AS version FROM schema_migrations'
const SELECT_COUNTS =
  'SELECT (SELECT count(*) FROM catalog) AS catalog, (SELECT count(*) FROM file_events) AS events, ' +
  '(SELECT last_seq FROM ingest_state WHERE id = 1) AS last_seq'

export async function readDbStatus(opts: ReadDbStatusOptions): Promise<DbStatus> {
  const pool = createPool(opts.pg, opts.url, opts.schema)
  try {
    const present = (await pool.query<{ present: boolean }>(SELECT_HAS_MIGRATIONS)).rows[0]?.present === true
    const version = present ? ((await pool.query<{ version: number | null }>(SELECT_VERSION)).rows[0]?.version ?? null) : null
    if (version === null) return { schemaVersion: null, catalogRows: 0, eventRows: 0, lastSeq: 0 }
    const counts = (await pool.query<CountRow>(SELECT_COUNTS)).rows[0]
    return {
      schemaVersion: version,
      catalogRows: Number(counts?.catalog ?? 0),
      eventRows: Number(counts?.events ?? 0),
      lastSeq: Number(counts?.last_seq ?? 0),
    }
  } catch (error: unknown) {
    throw mapPgError(error, { url: opts.url, schema: opts.schema, cli: opts.cli })
  } finally {
    await pool.end().catch(() => undefined)
  }
}
