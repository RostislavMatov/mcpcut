import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openFilesDb } from '../../../src/files/db/connection.js'
import { loadPg } from '../../../src/files/db/pg-loader.js'
import { syncOnce, type SyncOptions } from '../../../src/files/db/sync.js'
import { createIndexFixture, NOW, ruleOn, type IndexFixture } from './index-fixture.js'
import { describePg, PG_URL, withTestSchema } from '../db/pg-helpers.js'

let fx: IndexFixture
let journalDir: string
beforeEach(async () => {
  fx = await createIndexFixture()
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-sync-index-'))
})
afterEach(async () => {
  await fx.cleanup()
  await rm(journalDir, { recursive: true, force: true })
})

function base(extra: Partial<SyncOptions> = {}): SyncOptions {
  return { journalDir, roots: [fx.root], platform: process.platform, now: NOW, withWalk: true, ...extra }
}

describePg('syncOnce with the index', () => {
  test('walks the catalog, then indexes the files of an enabled rule', async () => {
    await fx.put({ 'a.md': 'alpha', 'b.md': 'beta' })

    const synced = await syncOnce(fx.db, base({ index: { rules: [ruleOn(fx.root)], embedder: async () => fx.embedder, budgetMs: 10_000 } }))

    expect(synced.index?.result).toMatchObject({ indexed: 2, failed: 0 })
    expect(synced.index?.problem).toBeUndefined()
  })

  test('a missing runtime is returned as a problem line, not thrown, and the ingest result stays', async () => {
    await fx.put({ 'a.md': 'alpha' })
    const missing = 'search by meaning is not installed: run `mcpcut files setup --search`'

    const synced = await syncOnce(
      fx.db,
      base({ index: { rules: [ruleOn(fx.root)], embedder: () => Promise.reject(new Error(missing)), budgetMs: 10_000 } }),
    )

    expect(synced.index).toEqual({ problem: missing })
    expect(synced.ingest.lastSeq).toBe(0)
    expect(synced.walks).toHaveLength(1)
  })

  test('without an enabled rule the embedder is never created', async () => {
    await fx.put({ 'a.md': 'alpha' })
    let created = 0

    const synced = await syncOnce(
      fx.db,
      base({ index: { rules: [ruleOn(fx.root, false)], embedder: async () => (created += 1, fx.embedder), budgetMs: 10_000 } }),
    )

    expect(created).toBe(0)
    expect(synced.index?.result).toMatchObject({ indexed: 0, removed: 0 })
  })

  test('turning the rule off clears the index on the next sync', async () => {
    await fx.put({ 'a.md': 'alpha' })
    const on = { rules: [ruleOn(fx.root)], embedder: async () => fx.embedder, budgetMs: 10_000 }
    await syncOnce(fx.db, base({ index: on }))

    const synced = await syncOnce(fx.db, base({ index: { ...on, rules: [ruleOn(fx.root, false)] } }))

    expect(synced.index?.result?.removed).toBe(1)
    expect((await fx.db.query('SELECT 1 FROM search_files')).rows).toEqual([])
  })

  test('a database that never had search tables is left alone when no rule is on', async () => {
    const schema = withTestSchema()
    const db = await openFilesDb({ pg: await loadPg(process.cwd()), url: PG_URL, schema: schema.schema })
    try {
      const synced = await syncOnce(db, base({ withWalk: false, index: { rules: [], embedder: async () => fx.embedder, budgetMs: 1000 } }))

      expect(synced.index).toBeUndefined()
      const tables = await db.query("SELECT to_regclass('search_files') IS NOT NULL AS present")
      expect(tables.rows).toEqual([{ present: false }])
    } finally {
      await db.close()
      await schema.cleanup()
    }
  })

  test('without the index option the index is not touched', async () => {
    await fx.put({ 'a.md': 'alpha' })

    const synced = await syncOnce(fx.db, base())

    expect(synced.index).toBeUndefined()
    expect((await fx.db.query('SELECT 1 FROM search_files')).rows).toEqual([])
  })
})
