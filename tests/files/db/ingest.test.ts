import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openFilesDb, type FilesDb } from '../../../src/files/db/connection.js'
import { ingestJournal } from '../../../src/files/db/ingest.js'
import { loadPg } from '../../../src/files/db/pg-loader.js'
import { ACCESS_EDIT_SESSION_ID } from '../../../src/journal/access-edit-record.js'
import { call, edit, writeJournal } from './journal-fixtures.js'
import { describePg, PG_URL, withTestSchema } from './pg-helpers.js'

let dir: string
let db: FilesDb
let cleanup: () => Promise<void>
const data = resolve('/data')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-ingest-'))
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

const run = (extra: Partial<Parameters<typeof ingestJournal>[1]> = {}) =>
  ingestJournal(db, { journalDir: dir, platform: 'linux', budgetMs: 60_000, ...extra })

interface EventRow {
  journal_seq: string
  action: string
  actor_kind: string
  actor_name: string | null
  actor_via: string | null
  agent_key: string | null
  subject_kind: string | null
  subject_name: string | null
  outcome: string | null
  rule: string | null
  paths: string[]
}

const events = async () =>
  (await db.query<EventRow>('SELECT * FROM file_events ORDER BY journal_seq')).rows

describePg('ingestJournal on a real Postgres', () => {
  test('only file calls and admin edits land, with the right columns', async () => {
    await writeJournal(dir, 's1', [
      call({ agent: 'bot', tool: 'read_file', payload: { path: `${data}/a` } }),
      call({ agent: 'bot', server: 'notes', tool: 'read_note', payload: { path: `${data}/n` } }),
      call({ agent: 'bot', tool: 'move_file', outcome: 'deny', rule: 'no', payload: { source: `${data}/s`, destination: `${data}/d` } }),
    ])
    await writeJournal(dir, ACCESS_EDIT_SESSION_ID, [
      edit('2026-10-04T11:00:00.000Z', { action: 'files.grant', agent: 'bot', path: `${data}/g` }),
      edit('2026-10-04T11:00:01.000Z', { action: 'vault.set', vaultEntry: 'x' }),
    ])

    const result = await run()
    const rows = await events()

    expect(result).toMatchObject({ added: 3, caughtUp: true })
    expect(rows.map((row) => row.action)).toEqual(['read_file', 'move_file', 'files.grant'])
    expect(rows[0]).toMatchObject({ actor_kind: 'agent', actor_name: 'bot', agent_key: 'bot', outcome: 'allow', paths: [`${data}/a`] })
    expect(rows[1]).toMatchObject({ outcome: 'deny', rule: 'no', paths: [`${data}/s`, `${data}/d`] })
    expect(rows[2]).toMatchObject({ actor_kind: 'admin', actor_name: 'ann', actor_via: 'cli', agent_key: 'bot', subject_kind: 'agent', subject_name: 'bot', outcome: null })
    const paths = await db.query<{ ord: number; path_key: string; is_tree: boolean }>(
      'SELECT ord, path_key, is_tree FROM file_event_paths WHERE journal_seq = $1 ORDER BY ord',
      [rows[1]?.journal_seq],
    )
    expect(paths.rows).toEqual([
      { ord: 0, path_key: `${data}/s`, is_tree: true },
      { ord: 1, path_key: `${data}/d`, is_tree: true },
    ])
    expect((await db.query<{ last_seq: string }>('SELECT last_seq FROM ingest_state')).rows[0]?.last_seq).toBe(String(result.journalMaxSeq))
  })

  test('relative paths are kept in the event but get no key; folding follows the platform', async () => {
    await writeJournal(dir, 's1', [call({ payload: { path: 'rel/x' } }), call({ payload: { path: '/Data/MiXed' } })])
    await run({ platform: 'darwin' })
    const keys = await db.query<{ path_key: string }>('SELECT path_key FROM file_event_paths')
    expect(keys.rows).toEqual([{ path_key: '/data/mixed' }])
    expect((await events())[0]?.paths).toEqual(['rel/x'])
  })

  test('a second ingest adds nothing; new records are picked up from the cursor', async () => {
    await writeJournal(dir, 's1', [call({ payload: { path: `${data}/a` } })])
    await run()
    expect(await run()).toMatchObject({ added: 0, caughtUp: true })
    await writeJournal(dir, 's2', [call({ payload: { path: `${data}/b` } })])
    expect(await run()).toMatchObject({ added: 1 })
    expect(await events()).toHaveLength(2)
  })

  test('two ingests in parallel never duplicate', async () => {
    await writeJournal(dir, 's1', Array.from({ length: 30 }, (_, i) => call({ payload: { path: `${data}/f${i}` } })))
    const both = await Promise.all([run({ batchSize: 7 }), run({ batchSize: 7 })])
    expect(both.reduce((sum, one) => sum + one.added, 0)).toBe(30)
    expect(await events()).toHaveLength(30)
  })

  test('a budget of 0 ms stops after at most one batch', async () => {
    await writeJournal(dir, 's1', Array.from({ length: 10 }, (_, i) => call({ payload: { path: `${data}/f${i}` } })))
    const first = await run({ batchSize: 4, budgetMs: 0 })
    expect(first).toMatchObject({ added: 4, caughtUp: false })
    const rest = await run({ batchSize: 4 })
    expect(rest).toMatchObject({ added: 6, caughtUp: true })
  })

  test('records that are not file events still advance the cursor', async () => {
    await writeJournal(dir, 's1', [call({ server: 'notes', payload: {} })])
    const result = await run()
    expect(result).toMatchObject({ added: 0, caughtUp: true, lastSeq: result.journalMaxSeq })
    expect(result.lastSeq).toBeGreaterThan(0)
  })

  test('a journal that is now smaller than the cursor was replaced: the index resets', async () => {
    await writeJournal(dir, 's1', [call({ payload: { path: `${data}/a` } })])
    await db.query('UPDATE ingest_state SET last_seq = 500')
    await db.query(
      "INSERT INTO file_events (journal_seq, record_id, session_id, ts, actor_kind, action, paths) VALUES (400, 'old', 's0', 't', 'agent', 'read_file', '{}')",
    )
    const result = await run()
    expect((await events()).map((row) => row.journal_seq)).toEqual(['1'])
    expect(result.lastSeq).toBe(1)
  })

  test('rows the journal no longer holds are removed after a prune', async () => {
    await writeJournal(dir, 's1', [call({ payload: { path: `${data}/a` } }), call({ payload: { path: `${data}/b` } }), call({ payload: { path: `${data}/c` } })])
    await run()
    const { openJournalDbIfPresent } = await import('../../../src/journal/db.js')
    const handle = (await openJournalDbIfPresent(dir))!
    handle.db.prepare('INSERT INTO journal_prune_marker (pruned_through_seq, pruned_at, deleted_count) VALUES (2, ?, 2)').run('2026-10-05T00:00:00.000Z')
    await run()
    expect((await events()).map((row) => row.journal_seq)).toEqual(['3'])
    expect((await db.query('SELECT 1 FROM file_event_paths WHERE journal_seq <= 2')).rowCount).toBe(0)
  })

  test('touched lists the paths of allowed writes, moves and deletes', async () => {
    await writeJournal(dir, 's1', [
      call({ tool: 'write_file', payload: { path: `${data}/w`, content: 'x' } }),
      call({ tool: 'write_file', outcome: 'deny', payload: { path: `${data}/denied` } }),
      call({ tool: 'read_file', payload: { path: `${data}/r` } }),
      call({ tool: 'move_file', payload: { source: `${data}/m1`, destination: `${data}/m2` } }),
      call({ tool: 'delete_file', payload: { path: `${data}/del` } }),
    ])
    const result = await run()
    expect([...result.touched].sort()).toEqual([`${data}/del`, `${data}/m1`, `${data}/m2`, `${data}/w`])
  })
})
