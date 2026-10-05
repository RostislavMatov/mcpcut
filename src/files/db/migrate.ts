import { SEARCH_MIGRATION_BASE } from '../search/constants.js'
import { DB_SCHEMA_PATTERN, MIGRATION_LOCK_KEY } from './constants.js'
import { FilesDbSchemaTooNewError } from './errors.js'
import { MIGRATIONS, type Migration } from './migrations.js'
import type { PgPool, PgQueryable } from './pg-types.js'

/** Refuses a schema name that could not be safely interpolated into SQL. */
export function assertSchemaName(schema: string): void {
  if (!DB_SCHEMA_PATTERN.test(schema)) {
    throw new Error(`invalid Postgres schema name "${schema.slice(0, 80)}": use lowercase letters, digits and underscores`)
  }
}

/**
 * The schema keeps two version ranges in one `schema_migrations` table: the
 * core track (everything below `SEARCH_MIGRATION_BASE`) and the search track
 * (from it up, applied only when search by meaning is used). A track reads and
 * compares only its own range, so a database that holds search tables is not
 * "too new" for a core-only mcpcut, and the other way round.
 */
export type MigrationTrack = 'core' | 'search'

function trackFilter(track: MigrationTrack): string {
  return track === 'core' ? `version < ${SEARCH_MIGRATION_BASE}` : `version >= ${SEARCH_MIGRATION_BASE}`
}

export async function appliedVersion(client: PgQueryable, track: MigrationTrack = 'core'): Promise<number> {
  const result = await client.query<{ version: number | null }>(
    `SELECT max(version) AS version FROM schema_migrations WHERE ${trackFilter(track)}`,
  )
  return result.rows[0]?.version ?? 0
}

async function applyOne(client: PgQueryable, migration: Migration): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query(migration.sql)
    await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [migration.version, migration.name])
    await client.query('COMMIT')
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

/** Applies what the track is missing on a client that already holds the migration lock. */
export async function migrateWith(
  client: PgQueryable,
  schema: string,
  migrations: readonly Migration[],
  track: MigrationTrack = 'core',
): Promise<number> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  )
  const current = await appliedVersion(client, track)
  const newest = migrations.reduce((max, migration) => Math.max(max, migration.version), 0)
  if (current > newest) throw new FilesDbSchemaTooNewError(current, newest)
  for (const migration of migrations.filter((candidate) => candidate.version > current)) {
    await applyOne(client, migration)
  }
  return Math.max(current, newest)
}

/**
 * Runs `fn` while this client holds the migration advisory lock, so two
 * processes at once apply each migration once. A failed unlock rejects, which
 * makes the owner of the client destroy it (a dropped session frees the lock).
 */
export async function underMigrationLock<T>(client: PgQueryable, fn: () => Promise<T>): Promise<T> {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
  let result: T
  try {
    result = await fn()
  } catch (error: unknown) {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined)
    throw error
  }
  await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
  return result
}

/**
 * Brings the track to the newest known version and returns it. One dedicated
 * client holds the advisory lock for the duration; every migration is its own
 * transaction.
 */
export async function migrate(
  pool: PgPool,
  schema: string,
  migrations: readonly Migration[] = MIGRATIONS,
  track: MigrationTrack = 'core',
): Promise<number> {
  assertSchemaName(schema)
  const client = await pool.connect()
  let failure: Error | undefined
  try {
    return await underMigrationLock(client, () => migrateWith(client, schema, migrations, track))
  } catch (error: unknown) {
    failure = error instanceof Error ? error : new Error(String(error))
    throw error
  } finally {
    client.release(failure)
  }
}
