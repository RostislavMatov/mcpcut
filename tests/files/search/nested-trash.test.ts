import { afterEach, beforeEach, expect, test } from 'vitest'
import { skipReasonOfName } from '../../../src/files/search/index-scope.js'
import { refreshCatalogPaths } from '../../../src/files/db/catalog-walk.js'
import { createSearchFixture, type SearchFixture } from './search-fixture.js'
import { describePg } from '../db/pg-helpers.js'

/** The trash of an inner root is not part of the outer root's tree either: never catalogued, never embedded. */

test.each([
  ['sub/.mcpcut-trash/01J0A', 'skipped folder'],
  ['sub/.MCPCUT-TRASH/01J0A.json', 'skipped folder'],
  ['.mcpcut-trash/01J0A', 'skipped folder'],
])('the trash folder at any depth is out of the index scope: %s', (relPath, expected) => {
  expect(skipReasonOfName(relPath, '/data/A')).toBe(expected)
})

describePg('two nested roots with a deleted file', () => {
  let fx: SearchFixture
  beforeEach(async () => {
    fx = await createSearchFixture()
  })
  afterEach(async () => {
    await fx.cleanup()
  })

  const files = {
    'A/pub.md': 'weather forecast tomorrow',
    'A/sub/keep.md': 'nothing related here at all',
    'A/sub/.mcpcut-trash/01J0000000000000000000000A': 'refund returns policy deleted draft',
    'A/sub/.mcpcut-trash/01J0000000000000000000000A.json': '{"originalPath":"/x/deleted.md"}',
  }

  test('the walk of the outer root does not catalogue the inner root trash', async () => {
    await fx.put(files)
    await fx.index([fx.dir('A'), fx.dir('A/sub')])

    const catalog = await fx.db.query<{ rel_path: string }>('SELECT rel_path FROM catalog WHERE root = $1', [fx.dir('A')])
    expect(catalog.rows.filter((row) => row.rel_path.includes('mcpcut-trash'))).toEqual([])
  })

  test('nothing of the inner root trash is indexed or embedded', async () => {
    await fx.put(files)
    await fx.index([fx.dir('A'), fx.dir('A/sub')])

    const rows = await fx.db.query<{ rel_path: string }>("SELECT rel_path FROM search_files WHERE rel_path LIKE '%mcpcut-trash%'")
    const chunks = await fx.db.query<{ rel_path: string }>("SELECT rel_path FROM search_chunks WHERE rel_path LIKE '%mcpcut-trash%'")
    expect([rows.rows.length, chunks.rows.length]).toEqual([0, 0])
  })

  test('a refresh of a path inside a nested trash records nothing', async () => {
    await fx.put(files)
    const trashed = fx.dir('A/sub/.mcpcut-trash/01J0000000000000000000000A')

    await refreshCatalogPaths(fx.db, { roots: [fx.dir('A')], paths: [trashed], now: new Date() })

    const catalog = await fx.db.query<{ rel_path: string }>("SELECT rel_path FROM catalog WHERE rel_path LIKE '%mcpcut-trash%'")
    expect(catalog.rows).toEqual([])
  })
})
