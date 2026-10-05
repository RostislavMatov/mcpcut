import { DB_SCHEMA_PATTERN, MIGRATION_LOCK_KEY } from './constants.js'
import { FilesDbSchemaTooNewError } from './errors.js'
import { MIGRATIONS, type Migration } from './migrations.js'
import type { PgPool, PgPoolClient } from './pg-types.js'

/** Refuses a schema name that could not be safely interpolated into SQL. */
export function assertSchemaName(schema: string): void {
  if (!DB_SCHEMA_PATTERN.test(schema)) {
    throw new Error(`invalid Postgres schema name "${schema.slice(0, 80)}": use lowercase letters, digits and underscores`)
  }
}

async function appliedVersion(client: PgPoolClient): Promise<number> {
  const result = await client.query<{ version: number | null }>('SELECT max(version) AS version FROM schema_migrations')
  return result.rows[0]?.version ?? 0
}

async function applyOne(client: PgPoolClient, migration: Migration): Promise<void> {
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

async function migrateWith(client: PgPoolClient, schema: string, migrations: readonly Migration[]): Promise<number> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  )
  const current = await appliedVersion(client)
  const newest = migrations.reduce((max, migration) => Math.max(max, migration.version), 0)
  if (current > newest) throw new FilesDbSchemaTooNewError(current, newest)
  for (const migration of migrations.filter((candidate) => candidate.version > current)) {
    await applyOne(client, migration)
  }
  return Math.max(current, newest)
}

/**
 * Brings the schema to the newest known version and returns it. One dedicated
 * client holds an advisory lock for the duration, so two processes opening the
 * database at once apply each migration once; every migration is its own
 * transaction.
 */
export async function migrate(pool: PgPool, schema: string, migrations: readonly Migration[] = MIGRATIONS): Promise<number> {
  assertSchemaName(schema)
  const client = await pool.connect()
  let failure: Error | undefined
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    return await migrateWith(client, schema, migrations)
  } catch (error: unknown) {
    failure = error instanceof Error ? error : new Error(String(error))
    throw error
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
    } catch {
      // A broken connection drops its session locks; releasing it with the error destroys it.
      failure = failure ?? new Error('advisory unlock failed')
    }
    client.release(failure)
  }
}
