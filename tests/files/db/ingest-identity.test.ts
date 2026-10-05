import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openFilesDb, type FilesDb } from '../../../src/files/db/connection.js'
import { ingestJournal } from '../../../src/files/db/ingest.js'
import { loadPg } from '../../../src/files/db/pg-loader.js'
import { openJournalDbIfPresent } from '../../../src/journal/db.js'
import { dbRecordIdAt, journalRecordIdAt } from '../../../src/journal/db-read-after.js'
import { call, writeJournal } from './journal-fixtures.js'
import { describePg, PG_URL, withTestSchema } from './pg-helpers.js'

let dirA: string
let dirB: string
let db: FilesDb
let cleanup: () => Promise<void>

beforeEach(async () => {
  dirA = await mkdtemp(join(tmpdir(), 'mcpcut-ident-a-'))
  dirB = await mkdtemp(join(tmpdir(), 'mcpcut-ident-b-'))
  const test_ = withTestSchema()
  cleanup = test_.cleanup
  if (PG_URL !== '') db = await openFilesDb({ pg: await loadPg(process.cwd()), url: PG_URL, schema: test_.schema })
})

afterEach(async () => {
  if (PG_URL !== '') {
    await db.close()
    await cleanup()
  }
  await Promise.all([rm(dirA, { recursive: true, force: true }), rm(dirB, { recursive: true, force: true })])
})

const run = (journalDir: string) => ingestJournal(db, { journalDir, platform: 'linux', budgetMs: 60_000 })
const paths = async () => (await db.query<{ p: string }>('SELECT paths[1] AS p FROM file_events ORDER BY journal_seq')).rows.map((row) => row.p)
const state = async () => (await db.query<{ last_seq: string; last_record_id: string | null }>('SELECT last_seq, last_record_id FROM ingest_state')).rows[0]
const three = (prefix: string) => [1, 2, 3].map((n) => call({ payload: { path: `/data/${prefix}${n}` } }))

test('the journal row at a seq is readable by its record_id, and a missing journal has none', async () => {
  await writeJournal(dirA, 's1', three('a'))
  const handle = (await openJournalDbIfPresent(dirA))!
  expect(dbRecordIdAt(handle, 2)).toMatch(/^01ARZ3/)
  expect(dbRecordIdAt(handle, 99)).toBeNull()
  expect(await journalRecordIdAt(dirB, 1)).toBeNull()
})

describePg('journal identity', () => {
  test('every advance stores the record_id of the journal row at the cursor', async () => {
    await writeJournal(dirA, 's1', three('a'))
    const result = await run(dirA)
    expect((await state())?.last_record_id).toBe(await journalRecordIdAt(dirA, result.lastSeq))
  })

  test('no journal.db: the index and the cursor are left alone', async () => {
    await writeJournal(dirA, 's1', three('a'))
    const first = await run(dirA)
    const result = await run(dirB)
    expect(result).toMatchObject({ added: 0, caughtUp: true, lastSeq: first.lastSeq })
    expect(await paths()).toEqual(['/data/a1', '/data/a2', '/data/a3'])
    expect((await state())?.last_seq).toBe(String(first.lastSeq))
  })

  test('another journal of the same length is a replaced one: the index restarts from it', async () => {
    await writeJournal(dirA, 's1', three('a'))
    await run(dirA)
    await writeJournal(dirB, 's1', [...three('b'), call({ payload: { path: '/data/b4' } })])
    const result = await run(dirB)
    expect(await paths()).toEqual(['/data/b1', '/data/b2', '/data/b3', '/data/b4'])
    expect(result.lastSeq).toBe(4)
  })

  test('the same journal is not mistaken for a replaced one', async () => {
    await writeJournal(dirA, 's1', three('a'))
    await run(dirA)
    await writeJournal(dirA, 's2', [call({ payload: { path: '/data/a4' } })])
    expect(await run(dirA)).toMatchObject({ added: 1 })
    expect(await paths()).toEqual(['/data/a1', '/data/a2', '/data/a3', '/data/a4'])
  })

  test('a cursor inside the pruned part is not compared', async () => {
    await writeJournal(dirA, 's1', three('a'))
    await run(dirA)
    await db.query("UPDATE ingest_state SET last_record_id = 'someone-else'")
    const handle = (await openJournalDbIfPresent(dirA))!
    handle.db.prepare('INSERT INTO journal_prune_marker (pruned_through_seq, pruned_at, deleted_count) VALUES (3, ?, 3)').run('2026-10-05T00:00:00.000Z')
    await run(dirA)
    expect((await state())?.last_seq).toBe('3')
  })

  test('a cursor with no stored record_id is rebuilt', async () => {
    await writeJournal(dirA, 's1', three('a'))
    await run(dirA)
    await db.query('UPDATE ingest_state SET last_record_id = NULL')
    expect(await run(dirA)).toMatchObject({ added: 3 })
    expect(await paths()).toHaveLength(3)
  })
})
