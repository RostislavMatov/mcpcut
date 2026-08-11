import { describe, expect, test } from 'vitest'
import { generateToken, MIN_TOKEN_RANDOM_BYTES } from '../../src/security/token.js'

/**
 * M4 review fix L4: the shared token machinery is parameterized by prefix and
 * entropy, so a future caller (the admin store binds its own pair) must not be
 * able to mint a weak or unprefixed token by passing a careless argument. One
 * guard, fail fast.
 */

describe('generateToken parameter guard', () => {
  test('MIN_TOKEN_RANDOM_BYTES is 16 (128 bits — the floor for a bearer credential)', () => {
    expect(MIN_TOKEN_RANDOM_BYTES).toBe(16)
  })

  test.each([0, 1, 8, 15])('randomByteCount below the floor (%i) throws', (count) => {
    expect(() => generateToken('mcpx_', count)).toThrow(/random/i)
  })

  test('an empty prefix throws (a prefix is what makes a leaked token attributable)', () => {
    expect(() => generateToken('', 32)).toThrow(/prefix/i)
  })

  test('the floor itself is accepted', () => {
    const { token, hash } = generateToken('mcpx_', MIN_TOKEN_RANDOM_BYTES)

    expect(token.startsWith('mcpx_')).toBe(true)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})
