import { describe, expect, test } from 'vitest'
import { GENESIS_PREV_HASH, linkHashOf } from '../../src/journal/chain.js'
import { sha256Hex } from '../../src/policy/hash.js'

/**
 * Pure unit tests for the chain link function (M5 wave 3, task 3.2). No SQL,
 * no filesystem — `db.test.ts` covers wiring `linkHashOf` into
 * `insertRecordRows`; this file covers the function in isolation.
 */

describe('GENESIS_PREV_HASH', () => {
  test('is the empty string', () => {
    expect(GENESIS_PREV_HASH).toBe('')
  })
})

describe('linkHashOf', () => {
  test('computes sha256Hex(prevHash + "\\n" + sha256Hex(doc))', () => {
    const prevHash = 'some-prior-hash'
    const doc = '{"hello":"world"}'

    expect(linkHashOf(prevHash, doc)).toBe(sha256Hex(`${prevHash}\n${sha256Hex(doc)}`))
  })

  test('genesis: an empty prevHash still produces a well-formed 64-hex-char digest', () => {
    const hash = linkHashOf(GENESIS_PREV_HASH, '{"hello":"world"}')

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('is deterministic: the same (prevHash, doc) pair always hashes the same', () => {
    expect(linkHashOf('prev', '{"a":1}')).toBe(linkHashOf('prev', '{"a":1}'))
  })

  test('different docs at the same prevHash produce different hashes', () => {
    expect(linkHashOf('prev', '{"a":1}')).not.toBe(linkHashOf('prev', '{"a":2}'))
  })

  test('the same doc at a different prevHash produces a different hash (chain position matters)', () => {
    expect(linkHashOf('prev-a', '{"a":1}')).not.toBe(linkHashOf('prev-b', '{"a":1}'))
  })

  test('hashes over the doc bytes, not a canonical re-serialization of them', () => {
    // Two JSON strings that are semantically identical but byte-different
    // (whitespace differs) must NOT hash the same here: the chain attests
    // the exact bytes stored, not a semantic reinterpretation of them (plan
    // design decision 3) — contrast `policy/hash.ts`'s `canonicalJson`.
    const spaced = '{"a": 1, "b": 2}'
    const compact = '{"a":1,"b":2}'

    expect(linkHashOf('prev', spaced)).not.toBe(linkHashOf('prev', compact))
  })
})
