import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { queryFileAudit, type FileAuditQuery } from '../../../src/files/audit.js'
import { queryFileAuditDb } from '../../../src/files/db/audit-db.js'
import { openFilesDb, type FilesDb } from '../../../src/files/db/connection.js'
import { ingestJournal } from '../../../src/files/db/ingest.js'
import { loadPg } from '../../../src/files/db/pg-loader.js'
import { ACCESS_EDIT_SESSION_ID } from '../../../src/journal/access-edit-record.js'
import { call, edit, incompressible, writeJournal } from './journal-fixtures.js'
import { describePg, PG_URL, withTestSchema } from './pg-helpers.js'

/** The Postgres audit is pinned to the journal audit: the same journal, the same queries, the same entries. */

let dir: string
let db: FilesDb
let cleanup: () => Promise<void>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-audit-db-'))
  const schema = withTestSchema()
  cleanup = schema.cleanup
  if (PG_URL !== '') db = await openFilesDb({ pg: await loadPg(process.cwd()), url: PG_URL, schema: schema.schema })
})

afterEach(async () => {
  if (PG_URL !== '') {
    await db.close()
    await cleanup()
  }
  await rm(dir, { recursive: true, force: true })
})

async function seed(): Promise<void> {
  await writeJournal(dir, 's1', [
    call({ ts: '2026-09-30T10:00:00.000Z', agent: 'bot', payload: { path: '/data/a/one.txt' } }),
    call({ ts: '2026-10-01T10:00:00.000Z', agent: 'bot', tool: 'write_file', payload: { path: '/data/a/two.txt', content: 'x' } }),
    call({ ts: '2026-10-01T10:00:00.000Z', agent: 'other', payload: { path: '/data/ab/three.txt' } }),
    call({ ts: '2026-10-02T10:00:00.000Z', agent: 'bot', tool: 'move_file', payload: { source: '/data/a', destination: '/data/moved' } }),
    call({ ts: '2026-10-02T11:00:00.000Z', tool: 'delete_file', outcome: 'deny', rule: 'no', payload: { path: '/data/a/two.txt' } }),
    call({ ts: '2026-10-02T12:00:00.000Z', agent: 'bot', server: 'notes', tool: 'x', payload: { path: '/data/a/x' } }),
    call({ ts: '2026-10-03T10:00:00.000Z', agent: 'bot', payload: { path: 'relative/p' } }),
    call({ ts: '2026-10-03T11:00:00.000Z', agent: 'bot', payload: { path: '/Data/A/Mixed.TXT' } }),
    call({ ts: '2026-10-03T11:00:00.000Z', agent: 'bot', payload: {} }),
  ])
  await writeJournal(dir, ACCESS_EDIT_SESSION_ID, [
    edit('2026-10-02T09:00:00.000Z', { action: 'files.grant', agent: 'bot', path: '/data' }),
    edit('2026-10-02T09:30:00.000Z', { action: 'files.root.add', path: '/data/a' }),
    edit('2026-10-02T09:45:00.000Z', { action: 'files.rule.set', group: 'staff', path: '/data/ab' }),
    edit('2026-10-02T09:50:00.000Z', { action: 'vault.set', vaultEntry: 'k' }),
  ])
}

const QUERIES: ReadonlyArray<readonly [string, Partial<FileAuditQuery>]> = [
  ['no filter', {}],
  ['exact file', { path: '/data/a/two.txt' }],
  ['a folder', { path: '/data/a' }],
  ['a folder with a trailing slash', { path: '/data/a/' }],
  ['a sibling that shares a prefix', { path: '/data/ab' }],
  ['the root of everything', { path: '/' }],
  ['a path nothing touched', { path: '/elsewhere' }],
  ['a relative query matches nothing', { path: 'relative/p' }],
  ['an alias', { path: '/data/ab', pathAliases: ['/data/a/two.txt'] }],
  ['agent', { agent: 'bot' }],
  ['agent and path', { agent: 'bot', path: '/data/a' }],
  ['an agent named by an edit', { agent: 'bot', path: '/data' }],
  ['since', { since: '2026-10-02' }],
  ['since and path', { since: '2026-10-02', path: '/data/a/two.txt' }],
  ['a limit with more', { limit: 3 }],
  ['a limit of one', { limit: 1, path: '/data/a' }],
]

describePg('queryFileAuditDb pinned to queryFileAudit', () => {
  test.each(QUERIES)('%s', async (_name, partial) => {
    await seed()
    await ingestJournal(db, { journalDir: dir, platform: 'linux', budgetMs: 60_000 })
    const query: FileAuditQuery = { limit: 100, ...partial }

    const fromJournal = await queryFileAudit(query, { dir, platform: 'linux' })
    const fromDb = await queryFileAuditDb(db, query, 'linux')

    expect(fromDb.entries).toEqual(fromJournal.entries)
    expect(fromDb.hasMore).toBe(fromJournal.hasMore)
    expect(fromDb.truncated).toBe(false)
  })

  test('case folding follows the platform like the journal walk', async () => {
    await seed()
    await ingestJournal(db, { journalDir: dir, platform: 'darwin', budgetMs: 60_000 })
    const query: FileAuditQuery = { limit: 100, path: '/data/A/MIXED.txt' }

    const fromJournal = await queryFileAudit(query, { dir, platform: 'darwin' })
    const fromDb = await queryFileAuditDb(db, query, 'darwin')

    expect(fromJournal.entries.length).toBeGreaterThan(0)
    expect(fromDb.entries).toEqual(fromJournal.entries)
  })

  test('the limit is clamped like the journal walk', async () => {
    await seed()
    await ingestJournal(db, { journalDir: dir, platform: 'linux', budgetMs: 60_000 })
    expect((await queryFileAuditDb(db, { limit: 0 }, 'linux')).entries).toHaveLength(1)
  })

  test('a 3000-character path is found by itself, by a parent folder and by a descendant query', async () => {
    const long = `/data/${incompressible(2990)}`
    await writeJournal(dir, 's1', [
      call({ payload: { path: `${long}/leaf.txt` } }),
      call({ tool: 'move_file', payload: { source: long, destination: '/data/elsewhere' } }),
      call({ payload: { path: `${long}x/sibling` } }),
    ])
    await ingestJournal(db, { journalDir: dir, platform: 'linux', budgetMs: 60_000 })
    const idsOf = async (path: string) => (await queryFileAuditDb(db, { limit: 10, path }, 'linux')).entries.map((entry) => entry.action).sort()

    expect(await idsOf(`${long}/leaf.txt`)).toEqual(['move_file', 'read_file'])
    expect(await idsOf(long)).toEqual(['move_file', 'read_file'])
    expect(await idsOf(`${long}/leaf.txt/`)).toEqual(['move_file', 'read_file'])
    expect(await idsOf('/data')).toEqual(['move_file', 'read_file', 'read_file'])
    expect(await idsOf(`${long}x`)).toEqual(['read_file'])
    expect(await idsOf(`${long}y`)).toEqual([])
  })
})
