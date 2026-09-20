import { describe, expect, test } from 'vitest'
import {
  POOL_NAME_HIDE_ABOVE_CHARS,
  POOL_NAME_WARN_ABOVE_CHARS,
} from '../../src/pool/constants.js'
import { decodePoolName, encodePoolName, poolNameFit } from '../../src/pool/name-codec.js'

/** Builds a tool name of exactly `total` characters once `server__` is prepended. */
function nameOfTotalLength(server: string, total: number): string {
  return 'x'.repeat(total - server.length - 2)
}

describe('encodePoolName', () => {
  test('prefixes the tool name with the server and the separator', () => {
    const encoded = encodePoolName('github', 'create_issue')

    expect(encoded).toBe('github__create_issue')
  })

  test.each([
    ['uppercase', 'GitHub'],
    ['an underscore, which would make the split ambiguous', 'git_hub'],
    ['a leading dash', '-github'],
    ['a colon, reserved for the auto: identity', 'auto:abc'],
    ['empty', ''],
    ['65 characters, one over the registry limit', 'a'.repeat(65)],
  ])('refuses a server name with %s', (_label, server) => {
    expect(encodePoolName(server, 'read')).toBeNull()
  })

  test('refuses an empty tool name, which would decode to nothing', () => {
    expect(encodePoolName('github', '')).toBeNull()
  })
})

describe('decodePoolName', () => {
  test('splits at the first separator, so a tool may contain one itself', () => {
    expect(decodePoolName('a__b__c')).toEqual({ server: 'a', name: 'b__c' })
  })

  test.each([
    ['github__create_issue', { server: 'github', name: 'create_issue' }],
    ['fs__read', { server: 'fs', name: 'read' }],
    ['x1__a.b', { server: 'x1', name: 'a.b' }],
    ['my-server__ns:tool', { server: 'my-server', name: 'ns:tool' }],
  ])('decodes %s', (poolName, expected) => {
    expect(decodePoolName(poolName)).toEqual(expected)
  })

  test.each([
    ['no separator at all', 'noseparator'],
    ['an empty server half', '__x'],
    ['an empty tool half', 'a__'],
    ['an uppercase server half', 'UPPER__x'],
    ['an underscore in the server half', 'a_b__x'],
    ['a server half over the registry limit', `${'a'.repeat(65)}__x`],
    ['nothing but the separator', '__'],
    ['an empty string', ''],
  ])('refuses %s', (_label, poolName) => {
    expect(decodePoolName(poolName)).toBeNull()
  })

  test('a hostile server cannot forge another server as the prefix', () => {
    // Server `a` exposes a tool literally called `other__drop`. The plane
    // prefixes it like any other, and decoding lands back on `a` — never on
    // `other` (ADR-0015 §2).
    const encoded = encodePoolName('a', 'other__drop')

    expect(encoded).toBe('a__other__drop')
    expect(decodePoolName(encoded!)).toEqual({ server: 'a', name: 'other__drop' })
  })

  test.each([
    ['plain', 'read'],
    ['with a separator inside', 'x__y'],
    ['with a leading separator', '__lead'],
    ['with a trailing separator', 'trail__'],
    ['with a dot', 'ns.read'],
    ['with a colon', 'ns:read'],
    ['with a dash', 'read-file'],
    ['a single character', 'r'],
  ])('round-trips a tool name %s', (_label, toolName) => {
    const encoded = encodePoolName('srv', toolName)

    expect(decodePoolName(encoded!)).toEqual({ server: 'srv', name: toolName })
  })
})

describe('poolNameFit', () => {
  test.each([
    [POOL_NAME_WARN_ABOVE_CHARS, 'ok'],
    [POOL_NAME_WARN_ABOVE_CHARS + 1, 'warn'],
    [POOL_NAME_HIDE_ABOVE_CHARS, 'warn'],
    [POOL_NAME_HIDE_ABOVE_CHARS + 1, 'hidden'],
  ])('classifies a name of %d characters as %s', (length, expected) => {
    const poolName = `srv__${'x'.repeat(length - 5)}`
    expect(poolName).toHaveLength(length)

    expect(poolNameFit(poolName)).toBe(expected)
  })

  test('a short name is plainly ok', () => {
    expect(poolNameFit('github__create_issue')).toBe('ok')
  })

  test('measures the encoded name, not the tool name alone', () => {
    const toolName = nameOfTotalLength('long-server-name', POOL_NAME_HIDE_ABOVE_CHARS + 1)
    const encoded = encodePoolName('long-server-name', toolName)

    expect(poolNameFit(toolName)).toBe('ok')
    expect(poolNameFit(encoded!)).toBe('hidden')
  })
})
