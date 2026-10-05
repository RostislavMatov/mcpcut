import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { queryFileAuditDb } from '../../../src/files/db/audit-db.js'
import { openFilesDb, type FilesDb } from '../../../src/files/db/connection.js'
import { ingestJournal } from '../../../src/files/db/ingest.js'
import { loadPg } from '../../../src/files/db/pg-loader.js'
import { call, incompressible, writeJournal } from './journal-fixtures.js'
import { describePg, PG_URL, withTestSchema } from './pg-helpers.js'

let dir: string
let db: FilesDb
let cleanup: () => Promise<void>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-poison-'))
  const test_ = withTestSchema()
  cleanup = test_.cleanup
  if (PG_URL !== '') db = await openFilesDb({ pg: await loadPg(process.cwd()), url: PG_URL, schema: test_.schema })
})

afterEach(async () => {
  if (PG_URL !== '') {
    await db.close()
    await cleanup()
  }
  await rm(dir, { recursive: true, force: true })
})

const run = () => ingestJournal(db, { journalDir: dir, platform: 'linux', budgetMs: 60_000 })
const LONG = `/data/${incompressible(2990)}`

describePg('poison records do not wedge the ingest', () => {
  test('a NUL, a lone surrogate and a 3000-char path are indexed in a cleaned form', async () => {
    await writeJournal(dir, 's1', [
      call({ payload: { path: '/data/nul\u0000x' } }),
      call({ payload: { path: '/data/lone\ud800y' } }),
      call({ payload: { path: LONG } }),
      call({ payload: { path: '/data/fine' } }),
    ])
    const result = await run()
    expect(result).toMatchObject({ added: 4, caughtUp: true, skipped: 0 })
    const rows = await db.query<{ paths: string[] }>('SELECT paths FROM file_events ORDER BY journal_seq')
    expect(rows.rows[0]?.paths).toEqual(['/data/nul�x'])
    expect(rows.rows[1]?.paths).toEqual(['/data/lone�y'])
  })

  test('a cleaned path is found under its cleaned spelling', async () => {
    await writeJournal(dir, 's1', [call({ payload: { path: '/data/nul\u0000x' } })])
    await run()
    const found = await queryFileAuditDb(db, { limit: 10, path: '/data/nul\u0000x' }, 'linux')
    expect(found.entries).toHaveLength(1)
  })

  test('a record the database still rejects is skipped, counted, and the cursor moves on', async () => {
    await writeJournal(dir, 's1', [call({ payload: { path: '/data/a' } }), call({ payload: { path: '/data/b' } }), call({ payload: { path: '/data/c' } })])
    await db.query(
      "CREATE FUNCTION refuse_b() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.paths = ARRAY['/data/b'] THEN " +
        "RAISE EXCEPTION 'refused' USING ERRCODE = '22023'; END IF; RETURN NEW; END $$",
    )
    await db.query('CREATE TRIGGER refuse_b BEFORE INSERT ON file_events FOR EACH ROW EXECUTE FUNCTION refuse_b()')
    const result = await run()
    expect(result).toMatchObject({ added: 2, skipped: 1, caughtUp: true })
    const rows = await db.query<{ paths: string[] }>('SELECT paths FROM file_events ORDER BY journal_seq')
    expect(rows.rows.map((row) => row.paths[0])).toEqual(['/data/a', '/data/c'])
    expect(await run()).toMatchObject({ added: 0, skipped: 0 })
  })
})
