import { describe, expect, test } from 'vitest'
import { findAtMost } from '../../src/files/text-search.js'

/** The reference: every start of `needle` in `text`, overlapping ones included. */
function naive(text: string, needle: string, limit: number): number[] {
  const found: number[] = []
  for (let at = text.indexOf(needle); at !== -1 && found.length < limit; at = text.indexOf(needle, at + 1)) found.push(at)
  return found
}

describe('findAtMost', () => {
  test('finds starts in order, overlapping ones included, up to the limit', () => {
    expect(findAtMost('aaaa', 'aa', 2)).toEqual([0, 1])
    expect(findAtMost('abcabc', 'abc', 5)).toEqual([0, 3])
    expect(findAtMost('abc', 'x', 2)).toEqual([])
    expect(findAtMost('ab', 'abc', 2)).toEqual([])
    expect(findAtMost('héllo wörld héllo', 'héllo', 2)).toEqual([0, 12])
  })

  test('agrees with indexOf on many random small texts', () => {
    let seed = 7
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const word = (length: number): string => Array.from({ length }, () => 'ab'[Math.floor(next() * 2)]).join('')
    for (let round = 0; round < 2000; round += 1) {
      const text = word(Math.floor(next() * 40))
      const needle = word(1 + Math.floor(next() * 5))
      expect(findAtMost(text, needle, 3), `${text} / ${needle}`).toEqual(naive(text, needle, 3))
    }
  })

  test('stays linear where indexOf is not: 10 MiB of "a" and a 64 KiB needle with one "b" in the middle', () => {
    const text = 'a'.repeat(10 * 1024 * 1024)
    const needle = `${'a'.repeat(32 * 1024)}b${'a'.repeat(32 * 1024)}`

    const started = performance.now()
    const found = findAtMost(text, needle, 2)
    const ms = performance.now() - started

    expect(found).toEqual([])
    expect(ms).toBeLessThan(2_000)
  })

  test('the empty needle is refused by the caller, never searched', () => {
    expect(() => findAtMost('abc', '', 2)).toThrow(/empty/)
  })
})
