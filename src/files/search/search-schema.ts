import type { FilesDb } from '../db/connection.js'
import { DB_SCHEMA_PATTERN } from '../db/constants.js'
import { FilesDbError } from '../db/errors.js'
import { appliedVersion, migrateWith, underMigrationLock } from '../db/migrate.js'
import type { Migration } from '../db/migrations.js'
import type { PgQueryable } from '../db/pg-types.js'
import { EMBED_DIMS, SEARCH_MIGRATION_BASE } from './constants.js'

/**
 * The search tables (ADR-0020 §6): a second migration track applied only when
 * search is used, so a Postgres without pgvector keeps phases 1-4 working. The
 * vector extension lives where it already is, or is created `WITH SCHEMA
 * public` — never inside the mcpcut schema, so dropping that schema never
 * drops the extension. Every statement that touches vectors names the type
 * qualified by that schema; the connection's `search_path` stays the mcpcut
 * schema only.
 */

export class FilesSearchPgvectorError extends FilesDbError {
  constructor(cli: string) {
    super(
      `this Postgres has no pgvector extension: use the container \`${cli} files db init\` prints, ` +
        'or install pgvector and run the command again',
    )
    this.name = 'FilesSearchPgvectorError'
  }
}

export interface SearchDb {
  readonly db: FilesDb
  /** The schema the vector type and its operators live in (`public` unless the server already had it elsewhere). */
  readonly vectorSchema: string
}

const SELECT_VECTOR_SCHEMA =
  "SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'"

function searchTablesSql(vectorSchema: string): string {
  return `
CREATE TABLE search_files (
  root text NOT NULL,
  rel_path text COLLATE "C" NOT NULL,
  path_key text COLLATE "C" NOT NULL,
  status text NOT NULL CHECK (status IN ('indexed', 'skipped')),
  reason text,
  sha256 text,
  size bigint NOT NULL,
  model text NOT NULL,
  chunks int NOT NULL,
  indexed_at timestamptz NOT NULL,
  PRIMARY KEY (root, rel_path)
);
CREATE TABLE search_chunks (
  root text NOT NULL,
  rel_path text COLLATE "C" NOT NULL,
  chunk_no int NOT NULL,
  start_line int NOT NULL,
  end_line int NOT NULL,
  body text NOT NULL,
  embedding ${vectorSchema}.vector(${EMBED_DIMS}) NOT NULL,
  PRIMARY KEY (root, rel_path, chunk_no),
  FOREIGN KEY (root, rel_path) REFERENCES search_files (root, rel_path) ON DELETE CASCADE
);
`
}

export function searchMigrations(vectorSchema: string): readonly Migration[] {
  return [{ version: SEARCH_MIGRATION_BASE + 1, name: 'search files and chunks', sql: searchTablesSql(vectorSchema) }]
}

async function vectorSchemaOf(client: PgQueryable): Promise<string | undefined> {
  const found = await client.query<{ schema: string }>(SELECT_VECTOR_SCHEMA)
  return found.rows[0]?.schema
}

async function ensureExtension(client: PgQueryable, cli: string): Promise<string> {
  const existing = await vectorSchemaOf(client)
  if (existing !== undefined) return existing
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public')
  } catch (error: unknown) {
    if (error instanceof FilesDbError && error.kind === 'unreachable') throw error
    throw new FilesSearchPgvectorError(cli)
  }
  const created = await vectorSchemaOf(client)
  if (created === undefined) throw new FilesSearchPgvectorError(cli)
  return created
}

function checkedVectorSchema(name: string, cli: string): string {
  if (!DB_SCHEMA_PATTERN.test(name)) throw new FilesSearchPgvectorError(cli)
  return name
}

export interface EnsureSearchSchemaOptions {
  /** The CLI prefix for the next steps inside error messages. */
  readonly cli?: string
}

/**
 * Finds or creates pgvector and brings the search tables to the newest
 * version, under the migration advisory lock. Cheap when nothing is to do:
 * the common path is two small reads without the lock.
 */
export async function ensureSearchSchema(db: FilesDb, opts: EnsureSearchSchemaOptions = {}): Promise<SearchDb> {
  const cli = opts.cli ?? 'mcpcut'
  const newest = SEARCH_MIGRATION_BASE + searchMigrations('public').length
  const known = await vectorSchemaOf(db)
  if (known !== undefined && (await appliedVersion(db, 'search')) === newest) {
    return { db, vectorSchema: checkedVectorSchema(known, cli) }
  }
  const vectorSchema = await db.withClient((client) =>
    underMigrationLock(client, async () => {
      const found = checkedVectorSchema(await ensureExtension(client, cli), cli)
      await migrateWith(client, db.schema, searchMigrations(found), 'search')
      return found
    }),
  )
  return { db, vectorSchema }
}
