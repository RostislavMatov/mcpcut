import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { INDEX_RETRY_FAILED_MS } from '../../../src/files/search/constants.js'
import { planIndex, type CatalogFile, type IndexRow } from '../../../src/files/search/index-plan.js'
import { indexOnce } from '../../../src/files/search/indexer.js'
import { readRuleCounts, readSearchTotals } from '../../../src/files/search/index-counts.js'
import { createIndexFixture, NOW, ruleOn, usingEmbedder, type IndexFixture } from './index-fixture.js'
import { describePg, PG_URL } from '../db/pg-helpers.js'
import { loadPg } from '../../../src/files/db/pg-loader.js'

/** An agent cannot starve the indexer: files wait their turn, and a poison file does not burn every round. */

const ROOT = '/data/a'
const file = (relPath: string, sha256 = `sha-${relPath}`): CatalogFile => ({ root: ROOT, relPath, size: 10, sha256 })
const row = (relPath: string, extra: Partial<IndexRow> = {}): IndexRow => ({
  root: ROOT,
  relPath,
  status: 'indexed',
  reason: null,
  sha256: 'old-sha',
  size: 10,
  model: 'm',
  chunks: 1,
  indexedAt: NOW.getTime(),
  ...extra,
})
const plan = (files: CatalogFile[], rows: IndexRow[], now = NOW) =>
  planIndex({ files, rows, rules: [{ path: ROOT, enabled: true, setAt: NOW.toISOString() }], platform: 'linux', model: 'm', now })
const orderOf = (files: CatalogFile[], rows: IndexRow[]): string[] => plan(files, rows).work.map((item) => item.file.relPath)

test('files with no row come first, then changed ones, the longest-waiting first', () => {
  const files = [file('a-changed-new'), file('b-changed-old'), file('z-never'), file('c-never')]
  const rows = [row('a-changed-new', { indexedAt: 2000 }), row('b-changed-old', { indexedAt: 1000 })]

  expect(orderOf(files, rows)).toEqual(['c-never', 'z-never', 'b-changed-old', 'a-changed-new'])
})

test('files indexed at the same moment keep (root, rel_path) order', () => {
  const rows = [row('b', { indexedAt: 5 }), row('a', { indexedAt: 5 })]

  expect(orderOf([file('b'), file('a')], rows)).toEqual(['a', 'b'])
})

test('a file rewritten all the time does not go ahead of a file that waited longer', () => {
  const rows = [row('busy.md', { indexedAt: NOW.getTime() - 60_000 }), row('quiet.md', { indexedAt: NOW.getTime() - 3_600_000 })]

  expect(orderOf([file('busy.md'), file('quiet.md')], rows)[0]).toBe('quiet.md')
})

test('a file that failed with this content waits for the retry delay, a changed one does not', () => {
  const failed = row('p.md', { status: 'skipped', reason: 'failed', sha256: 'sha-p.md' })
  const justBefore = new Date(NOW.getTime() + INDEX_RETRY_FAILED_MS - 1)
  const atDelay = new Date(NOW.getTime() + INDEX_RETRY_FAILED_MS)

  expect(plan([file('p.md')], [failed], justBefore).work).toEqual([])
  expect(plan([file('p.md')], [failed], atDelay).work).toHaveLength(1)
  expect(plan([file('p.md', 'new-sha')], [failed], justBefore).work).toHaveLength(1)
})

describe('one folder cannot starve another', () => {
  const rules = [
    { path: '/data/a', enabled: true, setAt: NOW.toISOString() },
    { path: '/data/b', enabled: true, setAt: NOW.toISOString() },
    { path: '/data/b/inner', enabled: true, setAt: NOW.toISOString() },
  ]
  const under = (relPath: string): CatalogFile => ({ root: '/data', relPath, size: 10, sha256: `sha-${relPath}` })
  const planWork = (files: CatalogFile[], rows: IndexRow[] = []) =>
    planIndex({ files, rows, rules, platform: 'linux', model: 'm', now: NOW }).work.map((item) => item.file.relPath)

  test('work alternates between the rules covering the files, however many files one folder has', () => {
    const flood = Array.from({ length: 5 }, (_, index) => under(`a/f${index}.md`))

    expect(planWork([...flood, under('b/x.md'), under('b/inner/y.md')])).toEqual(['a/f0.md', 'b/inner/y.md', 'b/x.md', 'a/f1.md', 'a/f2.md', 'a/f3.md', 'a/f4.md'])
  })

  test('inside one folder the longest-waiting still goes first', () => {
    const rows = [row('a/old.md', { root: '/data', indexedAt: 1000 }), row('a/new.md', { root: '/data', indexedAt: 2000 })]

    expect(planWork([under('a/new.md'), under('b/x.md'), under('a/old.md')], rows)).toEqual(['b/x.md', 'a/old.md', 'a/new.md'])
  })

  test('a single folder keeps the plain order', () => {
    expect(planWork([under('a/2.md'), under('a/1.md')])).toEqual(['a/1.md', 'a/2.md'])
  })
})

describePg('a failing file on Postgres', () => {
  let fx: IndexFixture
  beforeEach(async () => {
    fx = await createIndexFixture()
  })
  afterEach(async () => {
    await fx.cleanup()
  })

  function poisoned(attempts: string[]) {
    return {
      ...fx.embedder,
      embedPassage: async (text: string) => {
        if (text.includes('poison')) {
          attempts.push(text)
          throw new Error('model exploded')
        }
        return fx.embedder.embedPassage(text)
      },
    }
  }

  test('is parked: the next round does not embed it again, and it is counted failed', async () => {
    await fx.put({ 'a.md': 'good', 'p.md': 'poison' })
    await fx.walk()
    const attempts: string[] = []

    const first = await indexOnce(fx.sdb, fx.options(usingEmbedder(poisoned(attempts))))
    const second = await indexOnce(fx.sdb, fx.options(usingEmbedder(poisoned(attempts))))

    const parked = await fx.db.query<{ status: string; reason: string; sha256: string; model: string }>("SELECT status, reason, sha256, model FROM search_files WHERE rel_path = 'p.md'")
    expect([first.failed, second.failed, second.indexed, attempts.length]).toEqual([1, 0, 0, 1])
    expect(parked.rows[0]).toMatchObject({ status: 'skipped', reason: 'failed', model: fx.embedder.model })
    expect(parked.rows[0]?.sha256).toHaveLength(64)
  })

  test('is tried again when its content changes, and after the retry delay', async () => {
    await fx.put({ 'p.md': 'poison' })
    await fx.walk()
    const attempts: string[] = []
    await indexOnce(fx.sdb, fx.options(usingEmbedder(poisoned(attempts))))

    await fx.put({ 'p.md': 'poison changed' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await fx.walk()
    await indexOnce(fx.sdb, fx.options(usingEmbedder(poisoned(attempts))))
    await indexOnce(fx.sdb, fx.options({ ...usingEmbedder(poisoned(attempts)), now: new Date(NOW.getTime() + INDEX_RETRY_FAILED_MS) }))

    expect(attempts).toHaveLength(3)
  })

  test('the index list and status counts show failed files apart from skipped ones', async () => {
    await fx.put({ 'a.md': 'good', 'p.md': 'poison' })
    await fx.walk()
    await indexOnce(fx.sdb, fx.options(usingEmbedder(poisoned([]))))
    const target = { pg: await loadPg(process.cwd()), url: PG_URL, schema: fx.schema, cli: 'mcpcut' }

    const totals = await readSearchTotals(target)
    const counts = await readRuleCounts(target, { roots: [fx.root], rules: [ruleOn(fx.root)], platform: process.platform, model: fx.embedder.model, now: NOW })

    expect(totals).toMatchObject({ indexed: 1, skipped: 0, failed: 1 })
    expect(counts?.get(fx.root)).toMatchObject({ indexed: 1, skipped: 0, failed: 1, pending: 0 })
  })
})
