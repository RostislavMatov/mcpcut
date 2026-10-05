import { afterEach, describe, expect, test } from 'vitest'
import { openFilesDb, type FilesDb } from '../../../src/files/db/connection.js'
import { FilesDbSchemaTooNewError } from '../../../src/files/db/errors.js'
import { migrate } from '../../../src/files/db/migrate.js'
import { MIGRATIONS } from '../../../src/files/db/migrations.js'
import { loadPg } from '../../../src/files/db/pg-loader.js'
import { SEARCH_MIGRATION_BASE } from '../../../src/files/search/constants.js'
import { ensureSearchSchema } from '../../../src/files/search/search-schema.js'
import { describePg, PG_URL, withTestSchema } from '../db/pg-helpers.js'

const cleanups: Array<() => Promise<void>> = []
const opened: FilesDb[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close().catch(() => undefined)))
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function open(schema?: string): Promise<{ db: FilesDb; schema: string }> {
  const fresh = withTestSchema()
  if (schema === undefined) cleanups.push(fresh.cleanup)
  const name = schema ?? fresh.schema
  const db = await openFilesDb({ pg: await loadPg(process.cwd()), url: PG_URL, schema: name })
  opened.push(db)
  return { db, schema: name }
}

const tablesOf = async (db: FilesDb): Promise<string[]> =>
  (
    await db.query<{ table_name: string }>(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name',
    )
  ).rows.map((row) => row.table_name)

describePg('ensureSearchSchema on a real Postgres', () => {
  test('creates the search tables and the vector column, with the extension outside the mcpcut schema', async () => {
    const { db, schema } = await open()

    const sdb = await ensureSearchSchema(db)

    expect(sdb.vectorSchema).toBe('public')
    expect(await tablesOf(db)).toEqual(expect.arrayContaining(['search_chunks', 'search_files']))
    const extension = await db.query<{ schema: string }>(
      "SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'",
    )
    expect(extension.rows).toEqual([{ schema: 'public' }])
    expect(schema).not.toBe('public')
  })

  test('a second call is a no-op', async () => {
    const { db } = await open()
    await ensureSearchSchema(db)

    await ensureSearchSchema(db)

    const versions = await db.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
    expect(versions.rows.map((row) => row.version)).toEqual([1, SEARCH_MIGRATION_BASE + 1])
  })

  test('two concurrent calls apply the migration once', async () => {
    const { db } = await open()

    const [first, second] = await Promise.all([ensureSearchSchema(db), ensureSearchSchema(db)])

    expect(first.vectorSchema).toBe(second.vectorSchema)
    const count = await db.query<{ n: string }>('SELECT count(*) AS n FROM schema_migrations WHERE version > 1000')
    expect(count.rows[0]?.n).toBe('1')
  })

  test('the vector column accepts a text-form vector and orders by cosine distance', async () => {
    const { db } = await open()
    const { vectorSchema } = await ensureSearchSchema(db)
    await db.query(
      "INSERT INTO search_files (root, rel_path, path_key, status, size, model, chunks, indexed_at) VALUES ('/r', 'a', '/r/a', 'indexed', 1, 'm', 1, now())",
    )
    const unit = (hot: number): string => `[${Array.from({ length: 384 }, (_, i) => (i === hot ? 1 : 0)).join(',')}]`
    await db.query(`INSERT INTO search_chunks VALUES ('/r', 'a', 0, 1, 1, 'x', $1::${vectorSchema}.vector)`, [unit(3)])

    const found = await db.query<{ distance: number }>(
      `SELECT embedding OPERATOR(${vectorSchema}.<=>) $1::${vectorSchema}.vector AS distance FROM search_chunks`,
      [unit(3)],
    )

    expect(Number(found.rows[0]?.distance)).toBeCloseTo(0, 5)
  })

  test('core migrate ignores search versions, and still refuses a too-new core schema', async () => {
    const { db, schema } = await open()
    await ensureSearchSchema(db)
    const pool = new (await loadPg(process.cwd())).Pool({ connectionString: PG_URL, max: 1, options: `-c search_path=${schema}` })
    try {
      await expect(migrate(pool, schema, MIGRATIONS)).resolves.toBe(1)
      await pool.query("INSERT INTO schema_migrations (version, name) VALUES (7, 'future')")
      await expect(migrate(pool, schema, MIGRATIONS)).rejects.toBeInstanceOf(FilesDbSchemaTooNewError)
    } finally {
      await pool.end()
    }
  })

  test('a search schema newer than known is refused on its own track', async () => {
    const { db } = await open()
    await ensureSearchSchema(db)
    await db.query("INSERT INTO schema_migrations (version, name) VALUES (1500, 'future search')")

    await expect(ensureSearchSchema(db)).rejects.toBeInstanceOf(FilesDbSchemaTooNewError)
  })
})
