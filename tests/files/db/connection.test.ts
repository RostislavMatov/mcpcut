import { afterEach, describe, expect, test } from 'vitest'
import { openFilesDb, type FilesDb } from '../../../src/files/db/connection.js'
import { FilesDbError, FilesDbSchemaTooNewError } from '../../../src/files/db/errors.js'
import { MIGRATIONS } from '../../../src/files/db/migrations.js'
import { loadPg } from '../../../src/files/db/pg-loader.js'
import { describePg, PG_URL, urlWithPassword, withTestSchema } from './pg-helpers.js'

const cleanups: Array<() => Promise<void>> = []
const opened: FilesDb[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close().catch(() => undefined)))
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function open(extra: Partial<Parameters<typeof openFilesDb>[0]> = {}): Promise<{ db: FilesDb; schema: string }> {
  const { schema, cleanup } = withTestSchema()
  cleanups.push(cleanup)
  const db = await openFilesDb({ pg: await loadPg(process.cwd()), url: PG_URL, schema, ...extra })
  opened.push(db)
  return { db, schema }
}

describePg('openFilesDb on a real Postgres', () => {
  test('creates the schema and applies version 1', async () => {
    const { db } = await open()
    expect(db.schemaVersion).toBe(1)
    const tables = await db.query<{ table_name: string }>(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name',
    )
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'catalog',
      'file_event_paths',
      'file_events',
      'ingest_state',
      'schema_migrations',
    ])
    const state = await db.query<{ last_seq: string }>('SELECT last_seq FROM ingest_state')
    expect(state.rows).toEqual([{ last_seq: '0' }])
  })

  test('opening twice is a no-op', async () => {
    const { schema } = await open()
    const again = await openFilesDb({ pg: await loadPg(process.cwd()), url: PG_URL, schema })
    opened.push(again)
    const count = await again.query<{ n: string }>('SELECT count(*) AS n FROM schema_migrations')
    expect(count.rows[0]?.n).toBe('1')
  })

  test('two opens in parallel both succeed and apply version 1 once', async () => {
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    const pg = await loadPg(process.cwd())
    const both = await Promise.all([openFilesDb({ pg, url: PG_URL, schema }), openFilesDb({ pg, url: PG_URL, schema })])
    opened.push(...both)
    const count = await both[0].query<{ n: string }>('SELECT count(*) AS n FROM schema_migrations')
    expect(count.rows[0]?.n).toBe('1')
  })

  test('a schema stamped newer than known is refused and nothing is applied', async () => {
    const { db, schema } = await open()
    await db.query("INSERT INTO schema_migrations (version, name) VALUES (99, 'future')")
    await expect(openFilesDb({ pg: await loadPg(process.cwd()), url: PG_URL, schema })).rejects.toThrow(FilesDbSchemaTooNewError)
    await expect(openFilesDb({ pg: await loadPg(process.cwd()), url: PG_URL, schema })).rejects.toThrow(
      'Postgres holds schema version 99, newer than this mcpcut knows (1): update mcpcut',
    )
  })

  test('a failing migration rolls back fully', async () => {
    const broken = [
      ...MIGRATIONS,
      { version: 2, name: 'broken', sql: 'CREATE TABLE half_done (id int); SELECT * FROM does_not_exist;' },
    ]
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    const pg = await loadPg(process.cwd())
    await expect(openFilesDb({ pg, url: PG_URL, schema, migrations: broken })).rejects.toBeInstanceOf(FilesDbError)
    const healthy = await openFilesDb({ pg, url: PG_URL, schema })
    opened.push(healthy)
    const half = await healthy.query("SELECT to_regclass('half_done') AS t")
    expect(half.rows[0]).toEqual({ t: null })
    expect(healthy.schemaVersion).toBe(1)
  })

  test('a wrong password gives the login line without the password', async () => {
    const wrong = 'wr0ng-p@ss:word'
    const pg = await loadPg(process.cwd())
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    const error = await openFilesDb({ pg, url: urlWithPassword(encodeURIComponent(wrong)), schema }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FilesDbError)
    const message = (error as Error).message
    expect(message).toContain('Postgres refused the login for mcpcut')
    expect(message).toContain('vault set files-pg-url')
    for (const leak of [wrong, encodeURIComponent(wrong)]) expect(message).not.toContain(leak)
  })

  test('a missing database is named', async () => {
    const url = new URL(PG_URL)
    url.pathname = '/mcpcut_no_such_db'
    const pg = await loadPg(process.cwd())
    await expect(openFilesDb({ pg, url: url.toString(), schema: 'x' })).rejects.toThrow('Postgres has no database "mcpcut_no_such_db"')
  })

  test('a query error is mapped and the transaction rolls back', async () => {
    const { db } = await open()
    await expect(
      db.transaction(async (tx) => {
        await tx.query('UPDATE ingest_state SET last_seq = 5')
        await tx.query('SELECT * FROM nope')
      }),
    ).rejects.toThrow(/^Postgres error 42P01/)
    const state = await db.query<{ last_seq: string }>('SELECT last_seq FROM ingest_state')
    expect(state.rows[0]?.last_seq).toBe('0')
  })

  test('an invalid schema name is refused before any SQL', async () => {
    await expect(openFilesDb({ pg: await loadPg(process.cwd()), url: PG_URL, schema: 'x; DROP SCHEMA public' })).rejects.toThrow(
      /invalid Postgres schema name/,
    )
  })
})

describe('openFilesDb without a server', () => {
  test('a closed port gives the not-reachable line within the timeout', async () => {
    const started = Date.now()
    const pg = await loadPg(process.cwd())
    const error = await openFilesDb({ pg, url: 'postgres://mcpcut:secret-pw@127.0.0.1:1/mcpcut', cli: 'mcpcut' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FilesDbError)
    expect((error as Error).message).toBe(
      'Postgres at 127.0.0.1:1 is not reachable: start it with `docker start mcpcut-postgres`, then `mcpcut files db status`',
    )
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
