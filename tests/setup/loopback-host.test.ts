import { describe, expect, test } from 'vitest'
import { isLoopbackHost } from '../../src/setup/bind-checks.js'

/**
 * `isLoopbackHost` decides who may skip a plain-http warning — or, for
 * `connect --url` (PE8), a plain-http REFUSAL. It began life judging an
 * address an operator typed into `--host`, where a string prefix over
 * `127.0.0.0/8` was good enough. It now also judges the host half of an
 * address that arrives from outside: `--remote` (admin token), the
 * `--*-public-url` flags, and the bridge's `--url` (agent token).
 *
 * Security review 2026-09-21, CRITICAL: `'127.'.startsWith` matched
 * `127.evil.com` — a perfectly ordinary DNS name that WHATWG `URL` parsing
 * leaves as a hostname rather than folding into an IPv4 literal. Every such
 * address was silently treated as "only this machine can reach it", so a
 * bearer token crossed the network in clear with no warning and no flag.
 * The `127.0.0.0/8` allowance now applies only to an actual IPv4 literal.
 */

describe('the real loopback addresses, in every spelling', () => {
  test.each([
    '127.0.0.1',
    '127.0.0.53',
    '127.255.255.254',
    'localhost',
    'LOCALHOST',
    '::1',
    '[::1]',
  ])('%s is loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true)
  })

  test('the whole 127.0.0.0/8 block still counts, which is why it is not just 127.0.0.1', () => {
    // A stub resolver's address is a plausible thing to bind, and warning
    // about it would train operators to ignore the warning that matters.
    expect(isLoopbackHost('127.0.0.53')).toBe(true)
  })
})

describe('a DNS name is never loopback just because it LOOKS like one', () => {
  test.each([
    '127.evil.com',
    '127.0.0.1.attacker.example',
    '127.0.0.1.nip.io',
    '127.foo',
    'localhost.attacker.example',
    'notlocalhost',
  ])('%s is not loopback — it resolves wherever its owner points it', (host) => {
    expect(isLoopbackHost(host)).toBe(false)
  })

  test('nor is a numeric-looking name outside the block, or a malformed one', () => {
    expect(isLoopbackHost('128.0.0.1')).toBe(false)
    expect(isLoopbackHost('10.0.0.5')).toBe(false)
    expect(isLoopbackHost('127.0.0.256')).toBe(false)
    expect(isLoopbackHost('127.0.0')).toBe(false)
    expect(isLoopbackHost('')).toBe(false)
  })
})

describe('what a URL parser has already normalized still works', () => {
  test.each(['http://127.1', 'http://0x7f000001', 'http://2130706433', 'http://[::1]'])(
    '%s normalizes to a loopback literal before this function sees it',
    (raw) => {
      expect(isLoopbackHost(new URL(raw).hostname)).toBe(true)
    },
  )

  test('and a lookalike name does NOT normalize away', () => {
    expect(isLoopbackHost(new URL('http://127.evil.com').hostname)).toBe(false)
  })
})
