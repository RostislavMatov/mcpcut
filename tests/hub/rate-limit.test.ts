import type { IncomingMessage } from 'node:http'
import { describe, expect, test } from 'vitest'
import { clientIpOf, createWindowCounter, rateLimitKeyOf } from '../../hub/src/rate-limit.js'

/**
 * `hub/src/rate-limit.ts`: the sliding-window counter behind the per-IP
 * limits on `/signin`, the callback and signups (HA12), and the client-IP
 * rule that decides whose window a request lands in (H6).
 */

function clockAt(start: number): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return { now: () => current, advance: (ms) => (current += ms) }
}

describe('createWindowCounter', () => {
  test('counts hits per key within the window', () => {
    const clock = clockAt(1_000)
    const counter = createWindowCounter({ windowMs: 60_000, clock: clock.now })

    counter.record('a')
    counter.record('a')
    counter.record('b')

    expect(counter.count('a')).toBe(2)
    expect(counter.count('b')).toBe(1)
    expect(counter.count('c')).toBe(0)
  })

  test('forgets hits older than the window', () => {
    const clock = clockAt(1_000)
    const counter = createWindowCounter({ windowMs: 60_000, clock: clock.now })
    counter.record('a')

    clock.advance(60_000)

    expect(counter.count('a')).toBe(0)
  })

  test('tryConsume admits up to the limit, then refuses without counting the refusal', () => {
    const counter = createWindowCounter({ windowMs: 60_000, clock: () => 5 })

    expect(counter.tryConsume('ip', 2)).toBe(true)
    expect(counter.tryConsume('ip', 2)).toBe(true)
    expect(counter.tryConsume('ip', 2)).toBe(false)
    expect(counter.count('ip')).toBe(2)
  })

  test('bounds the number of tracked keys, dropping the least recently touched', () => {
    const counter = createWindowCounter({ windowMs: 60_000, maxKeys: 2, clock: () => 5 })
    counter.record('a')
    counter.record('b')
    counter.record('a')
    counter.record('c')

    expect(counter.count('b')).toBe(0)
    expect(counter.count('a')).toBe(2)
    expect(counter.count('c')).toBe(1)
  })

  test('rejects a non-positive window', () => {
    expect(() => createWindowCounter({ windowMs: 0 })).toThrow(RangeError)
  })
})

function fakeRequest(remoteAddress: string | undefined, headers: Record<string, string | string[]> = {}): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

describe('clientIpOf', () => {
  test('uses the peer address when the header is not trusted', () => {
    const req = fakeRequest('10.0.0.5', { 'cf-connecting-ip': '203.0.113.9' })

    expect(clientIpOf(req, false)).toBe('10.0.0.5')
  })

  test('uses CF-Connecting-IP when trusted and it is a real IP', () => {
    const req = fakeRequest('172.18.0.2', { 'cf-connecting-ip': ' 2001:db8::1 ' })

    expect(clientIpOf(req, true)).toBe('2001:db8::1')
  })

  test('falls back to the peer when the trusted header is absent, repeated or not an IP', () => {
    expect(clientIpOf(fakeRequest('172.18.0.2'), true)).toBe('172.18.0.2')
    expect(clientIpOf(fakeRequest('172.18.0.2', { 'cf-connecting-ip': 'evil, 1.2.3.4' }), true)).toBe('172.18.0.2')
    expect(clientIpOf(fakeRequest('172.18.0.2', { 'cf-connecting-ip': ['1.2.3.4', '5.6.7.8'] }), true)).toBe(
      '172.18.0.2',
    )
  })

  test('names an unknown peer rather than throwing', () => {
    expect(clientIpOf(fakeRequest(undefined), false)).toBe('unknown')
  })
})

describe('rateLimitKeyOf', () => {
  test('an IPv4 address is its own key', () => {
    expect(rateLimitKeyOf('203.0.113.9')).toBe('203.0.113.9')
  })

  test('IPv6 addresses in one /64 share a key, whatever their spelling', () => {
    const key = rateLimitKeyOf('2001:db8:1:2::1')

    expect(key).toBe('2001:db8:1:2::/64')
    expect(rateLimitKeyOf('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe(key)
    expect(rateLimitKeyOf('2001:DB8:1:2:0:0:0:9')).toBe(key)
  })

  test('different /64s are different keys; compressed prefixes expand to zeros', () => {
    expect(rateLimitKeyOf('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64')
    expect(rateLimitKeyOf('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(rateLimitKeyOf('::1')).toBe('0:0:0:0::/64')
  })

  test('an IPv4-mapped IPv6 address is keyed as the IPv4 address', () => {
    expect(rateLimitKeyOf('::ffff:203.0.113.9')).toBe('203.0.113.9')
  })

  test('a zone index is ignored', () => {
    expect(rateLimitKeyOf('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
  })

  test('anything that is not an IP is passed through', () => {
    expect(rateLimitKeyOf('unknown')).toBe('unknown')
  })
})
