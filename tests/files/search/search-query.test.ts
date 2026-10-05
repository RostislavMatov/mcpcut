import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { prepareRules, type FileRule } from '../../../src/files/rights.js'
import { hasReadableIndexed, searchChunks, type SearchScope } from '../../../src/files/search/search-query.js'
import { SEARCH_MAX_PAGES, SEARCH_OVERFETCH } from '../../../src/files/search/constants.js'
import { fakeVector } from './fake-embedder.js'
import { createSearchFixture, type SearchFixture } from './search-fixture.js'
import { describePg } from '../db/pg-helpers.js'

/** The SQL filter narrows; the run-time rights check decides (ADR-0020 §2). */

let fx: SearchFixture
beforeEach(async () => {
  fx = await createSearchFixture()
})
afterEach(async () => {
  await fx.cleanup()
})

async function scopeOf(roots: readonly string[], rules: readonly FileRule[], sqlRules: readonly FileRule[] = rules): Promise<SearchScope> {
  const prepared = await prepareRules(rules)
  if (!prepared.ok) throw new Error(prepared.message)
  return { roots, rules: sqlRules, prepared: prepared.rules, platform: process.platform }
}

const request = (scope: SearchScope, limit = 10) => ({ ...scope, vector: fakeVector('alpha beta'), limit })

describePg('searchChunks', () => {
  test('a row the SQL lets through but the run-time check refuses is dropped', async () => {
    await fx.put({ 'A/ok.md': 'alpha beta', 'A/x/inner.md': 'alpha beta' })
    const a = fx.dir('A')
    await fx.index([a])
    const broadSql: FileRule[] = [{ path: a, ops: ['read'] }]
    const strictRights: FileRule[] = [{ path: a, ops: ['read'] }, { path: `${a}/x`, ops: [] }]

    const hits = await searchChunks(fx.sdb, request(await scopeOf([a], strictRights, broadSql)))

    expect(hits.map((hit) => hit.path)).toEqual([`${a}/ok.md`])
  })

  test('a file that is gone from disk is not returned although the index still has it', async () => {
    await fx.put({ 'A/gone.md': 'alpha beta', 'A/kept.md': 'alpha beta' })
    const a = fx.dir('A')
    await fx.index([a])
    await rm(`${a}/gone.md`)

    const hits = await searchChunks(fx.sdb, request(await scopeOf([a], [{ path: a, ops: ['read'] }])))

    expect(hits.map((hit) => hit.path)).toEqual([`${a}/kept.md`])
  })

  test('a readable match behind more refused rows than one page is still returned', async () => {
    const goneNames = Array.from({ length: 12 }, (_, index) => `gone${index}.md`)
    await fx.put({ ...Object.fromEntries(goneNames.map((name) => [`A/${name}`, 'alpha beta'])), 'A/kept.md': 'alpha beta gamma delta epsilon zeta' })
    const a = fx.dir('A')
    await fx.index([a])
    for (const name of goneNames) await rm(`${a}/${name}`)

    const hits = await searchChunks(fx.sdb, request(await scopeOf([a], [{ path: a, ops: ['read'] }]), 1))

    expect(hits.map((hit) => hit.path)).toEqual([`${a}/kept.md`])
  })

  test('paging stops after the page cap, so a flood of refused rows cannot make one search unbounded', async () => {
    const goneNames = Array.from({ length: SEARCH_MAX_PAGES * SEARCH_OVERFETCH + 8 }, (_, index) => `gone${index}.md`)
    await fx.put({ ...Object.fromEntries(goneNames.map((name) => [`A/${name}`, 'alpha beta'])), 'A/kept.md': 'alpha beta gamma delta epsilon zeta' })
    const a = fx.dir('A')
    await fx.index([a])
    for (const name of goneNames) await rm(`${a}/${name}`)

    const hits = await searchChunks(fx.sdb, request(await scopeOf([a], [{ path: a, ops: ['read'] }]), 1))

    expect(hits).toEqual([])
  })

  test('the same file under two nested roots shows once', async () => {
    await fx.put({ 'A/inner/doc.md': 'alpha beta' })
    const outer = fx.dir('A')
    const inner = fx.dir('A/inner')
    await fx.index([outer, inner])
    const rules: FileRule[] = [{ path: outer, ops: ['read'] }]

    const hits = await searchChunks(fx.sdb, request(await scopeOf([outer, inner], rules)))

    expect(hits.map((hit) => hit.path)).toEqual([`${inner}/doc.md`])
  })

  test('a rule on the filesystem root, whose key already ends with the separator, still matches', async () => {
    await fx.put({ 'A/doc.md': 'alpha beta' })
    const a = fx.dir('A')
    await fx.index([a])
    const scope = await scopeOf([a], [{ path: process.platform === 'win32' ? a.slice(0, 3) : '/', ops: ['read'] }])

    const hits = await searchChunks(fx.sdb, request(scope))

    expect(hits.map((hit) => hit.path)).toEqual([`${a}/doc.md`])
    expect(await hasReadableIndexed(fx.sdb, scope)).toBe(true)
  })

  test('limit applies after the rights check: cut-out files do not eat the answer', async () => {
    const files: Record<string, string> = { 'A/ok1.md': 'alpha beta gamma', 'A/ok2.md': 'alpha beta delta' }
    for (let n = 0; n < 6; n += 1) files[`A/private/p${n}.md`] = 'alpha beta'
    await fx.put(files)
    const a = fx.dir('A')
    await fx.index([a])
    const rules: FileRule[] = [{ path: a, ops: ['read'] }, { path: `${a}/private`, ops: [] }]

    const hits = await searchChunks(fx.sdb, request(await scopeOf([a], rules), 2))

    expect(hits.map((hit) => hit.path).sort()).toEqual([`${a}/ok1.md`, `${a}/ok2.md`])
  })

  test('an empty rule set reads nothing', async () => {
    await fx.put({ 'A/doc.md': 'alpha beta' })
    const a = fx.dir('A')
    await fx.index([a])
    const scope = await scopeOf([a], [])

    expect(await searchChunks(fx.sdb, request(scope))).toEqual([])
    expect(await hasReadableIndexed(fx.sdb, scope)).toBe(false)
  })
})
