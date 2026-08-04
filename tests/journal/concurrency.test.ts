import { describe, expect, test } from 'vitest'
import { mapWithConcurrency } from '../../src/journal/concurrency.js'

describe('mapWithConcurrency', () => {
  test('returns results in input order regardless of completion order', async () => {
    const items = [30, 10, 20]

    const results = await mapWithConcurrency(items, 3, (ms) => delay(ms).then(() => ms))

    expect(results).toEqual([30, 10, 20])
  })

  test('never runs more than `concurrency` calls at once', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i)
    let active = 0
    let maxActive = 0
    const concurrency = 4

    await mapWithConcurrency(items, concurrency, async (item) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(1)
      active -= 1
      return item
    })

    expect(maxActive).toBeLessThanOrEqual(concurrency)
  })

  test('processes every item exactly once, including more items than the concurrency bound', async () => {
    const items = Array.from({ length: 37 }, (_, i) => i)

    const results = await mapWithConcurrency(items, 5, (item) => Promise.resolve(item * 2))

    expect(results).toEqual(items.map((item) => item * 2))
  })

  test('returns an empty array for an empty input without throwing', async () => {
    const results = await mapWithConcurrency([], 5, (item: never) => Promise.resolve(item))

    expect(results).toEqual([])
  })

  test('propagates a rejection from `fn`', async () => {
    const items = [1, 2, 3]

    await expect(
      mapWithConcurrency(items, 2, async (item) => {
        if (item === 2) {
          throw new Error('boom')
        }
        return item
      }),
    ).rejects.toThrow('boom')
  })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
