import { afterEach, expect, test } from 'vitest'
import { FilesDbError } from '../../../src/files/db/errors.js'
import type { PgModule } from '../../../src/files/db/pg-types.js'
import { indexOnce } from '../../../src/files/search/indexer.js'
import { createFakeEmbedder } from './fake-embedder.js'
import { createIndexFixture, usingEmbedder, type IndexFixture } from './index-fixture.js'
import { describePg } from '../db/pg-helpers.js'

/** What a round holds while it works: pooled clients, and the model. */

let fx: IndexFixture | undefined
afterEach(async () => {
  await fx?.cleanup()
  fx = undefined
})

interface Peak {
  outstanding: number
  max: number
}

/** A pg module whose pools count the clients asked for and not yet released, and the most that were at once. */
function countingPg(peak: Peak): (pg: PgModule) => PgModule {
  return (pg) => {
    class CountingPool extends pg.Pool {
      constructor(...args: ConstructorParameters<typeof pg.Pool>) {
        super(...args)
        this.on('release', () => void (peak.outstanding -= 1))
      }
      override connect(...args: unknown[]): never {
        peak.outstanding += 1
        peak.max = Math.max(peak.max, peak.outstanding)
        return (super.connect as (...a: unknown[]) => never)(...args)
      }
    }
    return { ...pg, Pool: CountingPool as unknown as PgModule['Pool'] }
  }
}

describePg('indexer resources', () => {
  test('a round never asks the pool for more clients than it has (the lock holds one)', async () => {
    const peak: Peak = { outstanding: 0, max: 0 }
    fx = await createIndexFixture(countingPg(peak))
    await fx.put({ 'a.md': 'alpha', 'b.md': 'beta', '.env': 'X=1', 'c.md': 'gamma' })
    await fx.walk()
    peak.max = 0

    const result = await indexOnce(fx.sdb, fx.options())

    expect(result).toMatchObject({ indexed: 3, skipped: 1, failed: 0 })
    expect(peak.max).toBeGreaterThan(0)
    expect(peak.max).toBeLessThanOrEqual(2)
  })

  test('a round with nothing to embed never calls the factory', async () => {
    fx = await createIndexFixture()
    await fx.put({ 'a.md': 'alpha', '.env': 'X=1' })
    await fx.walk()
    await indexOnce(fx.sdb, fx.options())
    let calls = 0

    const result = await indexOnce(fx.sdb, fx.options({ createEmbedder: async () => (calls += 1, fx!.embedder) }))

    expect(result).toMatchObject({ indexed: 0, failed: 0 })
    expect(calls).toBe(0)
  })

  test('a round with work calls the factory once and closes the embedder at the end', async () => {
    fx = await createIndexFixture()
    await fx.put({ 'a.md': 'alpha', 'b.md': 'beta' })
    await fx.walk()
    const embedder = createFakeEmbedder()
    let calls = 0

    const result = await indexOnce(fx.sdb, fx.options({ ...usingEmbedder(embedder), createEmbedder: async () => (calls += 1, embedder) }))

    expect(result.indexed).toBe(2)
    expect(calls).toBe(1)
    expect(embedder.isClosed()).toBe(true)
  })

  test('an error in the middle of the round still closes the embedder', async () => {
    fx = await createIndexFixture()
    await fx.put({ 'a.md': 'alpha' })
    await fx.walk()
    const base = createFakeEmbedder()
    const failing = { ...base, embedPassage: () => Promise.reject(new FilesDbError('server gone', 'unreachable')) }

    await expect(indexOnce(fx.sdb, fx.options({ createEmbedder: async () => failing }))).rejects.toThrow('server gone')

    expect(base.isClosed()).toBe(true)
  })
})
