import { afterEach, beforeEach, expect, test } from 'vitest'
import { chunkText } from '../../../src/files/search/chunk.js'
import { indexOnce } from '../../../src/files/search/indexer.js'
import { createIndexFixture, type IndexFixture } from './index-fixture.js'
import { describePg } from '../db/pg-helpers.js'

/** One round embeds a bounded number of chunks: a huge file cannot hold the round for minutes. */

let fx: IndexFixture
beforeEach(async () => {
  fx = await createIndexFixture()
})
afterEach(async () => {
  await fx.cleanup()
})

const CAP = 3
/** Lines of 900 characters never share a chunk, so the text has exactly `count` chunks. */
const textOfChunks = (count: number): string => {
  const text = Array.from({ length: count }, (_, index) => `${index}`.repeat(900).slice(0, 900)).join('\n')
  expect(chunkText(text)).toHaveLength(count)
  return text
}
const indexedPaths = async (): Promise<string[]> =>
  (await fx.db.query<{ rel_path: string }>("SELECT rel_path FROM search_files WHERE status = 'indexed' ORDER BY rel_path")).rows.map((row) => row.rel_path)

describePg('the per-round chunk cap', () => {
  test('a file that does not fit what is left of the round waits, smaller ones still go, and it is first next round', async () => {
    await fx.put({ 'a.md': textOfChunks(1), 'b.md': textOfChunks(5), 'c.md': textOfChunks(1) })
    await fx.walk()

    const first = await indexOnce(fx.sdb, fx.options({ maxChunks: CAP }))

    expect(first).toMatchObject({ indexed: 2, pending: 1, failed: 0 })
    expect(await indexedPaths()).toEqual(['a.md', 'c.md'])
    const second = await indexOnce(fx.sdb, fx.options({ maxChunks: CAP }))
    expect(second).toMatchObject({ indexed: 1, pending: 0 })
    expect(await indexedPaths()).toEqual(['a.md', 'b.md', 'c.md'])
  })

  test('a file bigger than the cap still progresses when it is the first of the round', async () => {
    await fx.put({ 'a.md': textOfChunks(5), 'b.md': textOfChunks(1) })
    await fx.walk()

    const first = await indexOnce(fx.sdb, fx.options({ maxChunks: CAP }))

    expect(first).toMatchObject({ indexed: 1, pending: 1 })
    expect(await indexedPaths()).toEqual(['a.md'])
    expect(await indexOnce(fx.sdb, fx.options({ maxChunks: CAP }))).toMatchObject({ indexed: 1, pending: 0 })
  })

  test('a deferred file is never written as indexed, and the embedder is not asked for its chunks', async () => {
    await fx.put({ 'a.md': textOfChunks(2), 'b.md': textOfChunks(5) })
    await fx.walk()

    await indexOnce(fx.sdb, fx.options({ maxChunks: CAP }))

    const rows = await fx.db.query<{ rel_path: string }>("SELECT rel_path FROM search_files WHERE rel_path = 'b.md'")
    expect(rows.rows).toEqual([])
    expect(fx.embedder.calls).toHaveLength(2)
  })
})
