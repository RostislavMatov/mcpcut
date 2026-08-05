import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { AGENT_TOKEN_PREFIX } from '../../src/agents/constants.js'
import { generateToken, verifyToken } from '../../src/agents/tokens.js'

const TOKEN_GENERATION_SAMPLE = 100
/** 32 random bytes → 43 base64url chars (no padding). */
const BASE64URL_BODY_PATTERN = /^[A-Za-z0-9_-]{43}$/

describe('generateToken', () => {
  test('token starts with the mcpj_ prefix (secret-scanner friendly)', () => {
    // Act
    const { token } = generateToken()

    // Assert
    expect(token.startsWith(AGENT_TOKEN_PREFIX)).toBe(true)
  })

  test('token body is 43 chars of base64url (32 random bytes)', () => {
    const { token } = generateToken()

    const body = token.slice(AGENT_TOKEN_PREFIX.length)

    expect(body).toMatch(BASE64URL_BODY_PATTERN)
  })

  test('hash is the sha256 hex digest of the FULL token (prefix included)', () => {
    const { token, hash } = generateToken()

    const expected = createHash('sha256').update(token, 'utf8').digest('hex')

    expect(hash).toBe(expected)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('tokens are unique across many generations', () => {
    const tokens = new Set<string>()

    for (let i = 0; i < TOKEN_GENERATION_SAMPLE; i += 1) {
      tokens.add(generateToken().token)
    }

    expect(tokens.size).toBe(TOKEN_GENERATION_SAMPLE)
  })
})

describe('verifyToken', () => {
  test('accepts the token it was generated with', () => {
    const { token, hash } = generateToken()

    expect(verifyToken(token, hash)).toBe(true)
  })

  test('rejects a different token', () => {
    const { hash } = generateToken()
    const other = generateToken().token

    expect(verifyToken(other, hash)).toBe(false)
  })

  test('rejects a token differing by a single character', () => {
    const { token, hash } = generateToken()
    const lastChar = token.at(-1) === 'A' ? 'B' : 'A'
    const tampered = `${token.slice(0, -1)}${lastChar}`

    expect(verifyToken(tampered, hash)).toBe(false)
  })

  test('rejects an almost-identical hash (last hex digit flipped) — comparison is over full fixed-length digests', () => {
    const { token, hash } = generateToken()
    const lastDigit = hash.at(-1) === '0' ? '1' : '0'
    const nearMatch = `${hash.slice(0, -1)}${lastDigit}`

    expect(verifyToken(token, nearMatch)).toBe(false)
  })

  test.each([
    ['empty hash', ''],
    ['non-hex hash', 'z'.repeat(64)],
    ['odd-length hash', 'abc'],
    ['too-short hash', 'ab'.repeat(16)],
    ['too-long hash', 'ab'.repeat(64)],
    ['whitespace hash', '   '],
  ])('garbage stored hash (%s) → false, never throws', (_label, badHash) => {
    const { token } = generateToken()

    expect(() => verifyToken(token, badHash)).not.toThrow()
    expect(verifyToken(token, badHash)).toBe(false)
  })

  test('empty candidate token → false, never throws', () => {
    const { hash } = generateToken()

    expect(() => verifyToken('', hash)).not.toThrow()
    expect(verifyToken('', hash)).toBe(false)
  })
})
