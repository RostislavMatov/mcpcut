import { expect, test } from 'vitest'
import { planIndex } from '../../../src/files/search/index-plan.js'

test('the rule keys are computed once per round, not once per file', () => {
  let reads = 0
  const rule = {
    get path() {
      reads += 1
      return '/data/a'
    },
    enabled: true,
    setAt: '2026-10-05T10:00:00.000Z',
  }
  const files = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].map((relPath) => ({ root: '/data/a', relPath, size: 1, sha256: 'x' }))

  planIndex({ files, rows: [], rules: [rule], platform: 'linux', model: 'm', now: new Date('2026-10-05T12:00:00Z') })

  expect(reads).toBe(1)
})

test('files of a root declared inside a secret folder are neither indexed nor read', () => {
  const rule = { path: '/home/u/.ssh', enabled: true, setAt: '2026-10-05T10:00:00.000Z' }
  const files = [{ root: '/home/u/.ssh', relPath: 'config', size: 1, sha256: 'x' }]

  const plan = planIndex({ files, rows: [], rules: [rule], platform: 'linux', model: 'm', now: new Date('2026-10-05T12:00:00Z') })

  expect(plan.work).toEqual([])
})
