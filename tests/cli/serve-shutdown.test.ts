import { expect, test } from 'vitest'
import { stopAll } from '../../src/cli/serve-shutdown.js'

/** `serve` stops its background parts together: one that throws must not leave another open. */

test('every step runs even when an earlier one throws, and the first failure is rethrown', async () => {
  const ran: string[] = []

  const stopping = stopAll([
    async () => {
      ran.push('sync')
      throw new Error('sync stop failed')
    },
    async () => {
      ran.push('search')
    },
  ])

  await expect(stopping).rejects.toThrow('sync stop failed')
  expect(ran).toEqual(['sync', 'search'])
})

test('with no failure it resolves after all of them', async () => {
  const ran: string[] = []

  await stopAll([async () => void ran.push('a'), async () => void ran.push('b')])

  expect(ran).toEqual(['a', 'b'])
})
