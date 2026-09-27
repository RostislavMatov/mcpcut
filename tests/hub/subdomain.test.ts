import { describe, expect, test } from 'vitest'
import { RESERVED_SUBDOMAINS, SubdomainExhaustedError, assignSubdomain } from '../../hub/src/subdomain.js'

/**
 * `hub/src/subdomain.ts` (plan `hub-signin-accounts`, Task 2, HA1/HA4): a
 * pure function from a GitHub login to a free hub subdomain. `isOccupied` is
 * injected, so every test below is a plain table over a fake occupancy set —
 * no database.
 */

function occupiedSetOf(names: readonly string[]) {
  const set = new Set(names)
  return { isOccupied: (candidate: string) => set.has(candidate) }
}

describe('assignSubdomain: the free-path case', () => {
  test('a free, already-valid login is returned unchanged', () => {
    expect(assignSubdomain('alice', occupiedSetOf([]))).toBe('alice')
  })

  test('login is lowercased', () => {
    expect(assignSubdomain('Alice', occupiedSetOf([]))).toBe('alice')
  })

  test('a numeric-only login is a valid label', () => {
    expect(assignSubdomain('12345', occupiedSetOf([]))).toBe('12345')
  })
})

describe('assignSubdomain: normalization of untrusted input', () => {
  test('characters outside [a-z0-9-] fold to a hyphen', () => {
    expect(assignSubdomain('a_weird.login!', occupiedSetOf([]))).toBe('a-weird-login')
  })

  test('runs of hyphens collapse to one', () => {
    expect(assignSubdomain('a---b', occupiedSetOf([]))).toBe('a-b')
  })

  test('leading and trailing hyphens are trimmed', () => {
    expect(assignSubdomain('-alice-', occupiedSetOf([]))).toBe('alice')
  })

  test('a login that folds to nothing usable falls back to a stable placeholder', () => {
    expect(assignSubdomain('###', occupiedSetOf([]))).toBe('user')
  })

  test('an over-length login is cut to a valid 63-char label', () => {
    const long = 'a'.repeat(100)
    const result = assignSubdomain(long, occupiedSetOf([]))
    expect(result.length).toBeLessThanOrEqual(63)
    expect(result).toBe('a'.repeat(63))
  })

  test('a length cut that lands right on a hyphen re-trims it', () => {
    // 62 'a's + '-' sits exactly at the 63-char cut; slicing there would
    // leave a trailing hyphen, which must be trimmed off afterward.
    const crafted = `${'a'.repeat(62)}-bbbb`
    const result = assignSubdomain(crafted, occupiedSetOf([]))
    expect(result).toBe('a'.repeat(62))
    expect(result.endsWith('-')).toBe(false)
  })
})

describe('assignSubdomain: reserved names', () => {
  test('a login matching a reserved name gets a suffix', () => {
    expect(RESERVED_SUBDOMAINS.has('admin')).toBe(true)
    expect(assignSubdomain('admin', occupiedSetOf([]))).toBe('admin-2')
  })

  test('the suffix itself is also checked against reserved names', () => {
    const occupied = occupiedSetOf(['admin-2'])
    expect(assignSubdomain('admin', occupied)).toBe('admin-3')
  })
})

describe('assignSubdomain: collisions with an existing account', () => {
  test('an occupied login gets a "-2" suffix', () => {
    expect(assignSubdomain('alice', occupiedSetOf(['alice']))).toBe('alice-2')
  })

  test('suffixes climb until a free one is found', () => {
    expect(assignSubdomain('alice', occupiedSetOf(['alice', 'alice-2', 'alice-3']))).toBe('alice-4')
  })

  test('a new GitHub id claiming a login that belonged to a deleted account gets its own free name', () => {
    // The old "alice" row is gone from `accounts` (deleted), so a brand-new
    // "alice" login is free even though `alice-2` happens to be taken by
    // someone else entirely.
    const occupied = occupiedSetOf(['alice-2'])
    expect(assignSubdomain('alice', occupied)).toBe('alice')
  })

  test('exhausting every suffix attempt throws rather than looping forever', () => {
    const alwaysOccupied = { isOccupied: () => true }
    expect(() => assignSubdomain('alice', alwaysOccupied)).toThrow(SubdomainExhaustedError)
  })
})
