import { describe, expect, test } from 'vitest'
import { isHostAllowed, isOriginAllowed } from '../../src/net/origin-host.js'
import { applyPublicUrl, checkPublicUrl, parsePublicUrl, type PublicUrl } from '../../src/setup/public-url.js'

/**
 * `--ui-public-url` / `--serve-public-url` (2026-09-19): the ONE thing an
 * operator knows — the address they will type into a browser or an agent's
 * config — turned into the three settings the HTTP fronts need to answer it.
 */

function parsed(raw: string): PublicUrl {
  const result = parsePublicUrl('--ui-public-url', raw)
  if (!result.ok) throw new Error(result.message)
  return result.url
}

describe('parsePublicUrl', () => {
  test('an IP and a port: the Host entry carries the port, the origin is the URL without a path', () => {
    expect(parsed('http://203.0.113.7:8091')).toEqual({
      scheme: 'http',
      hostEntry: '203.0.113.7:8091',
      origin: 'http://203.0.113.7:8091',
      isLoopback: false,
      isIpv6: false,
    })
  })

  test('a default port is dropped, exactly as a browser drops it from the Host header', () => {
    expect(parsed('https://mcp.example.com:443/').hostEntry).toBe('mcp.example.com')
    expect(parsed('https://mcp.example.com').origin).toBe('https://mcp.example.com')
    expect(parsed('http://example.com:80').hostEntry).toBe('example.com')
  })

  test('the host is lower-cased and an IPv6 literal keeps its brackets', () => {
    expect(parsed('https://MCP.Example.COM').hostEntry).toBe('mcp.example.com')
    expect(parsed('http://[2001:db8::1]:8091')).toMatchObject({ hostEntry: '[2001:db8::1]:8091', isIpv6: true })
  })

  test('loopback addresses are recognised', () => {
    for (const raw of ['http://localhost:8091', 'http://127.0.0.1:8091', 'http://[::1]:8091']) {
      expect([raw, parsed(raw).isLoopback]).toEqual([raw, true])
    }
  })

  test.each([
    ['203.0.113.7:8091', 'http:// or https://'],
    ['ftp://203.0.113.7', 'http:// or https://'],
    ['http://203.0.113.7:8091/admin', 'path'],
    ['http://203.0.113.7:8091/?x=1', 'query'],
    ['http://203.0.113.7:8091/#top', 'fragment'],
    ['http://user:pw@203.0.113.7:8091', 'credentials'],
    ['http://', 'not a URL'],
    ['', 'not a URL'],
  ])('refuses %j with a sentence that names the flag and says why', (raw, reason) => {
    const result = parsePublicUrl('--ui-public-url', raw)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('--ui-public-url')
    expect(!result.ok && result.message).toContain(reason)
  })

  test.each(['http://0.0.0.0:8091', 'http://[::]:8091', 'https://0.0.0.0'])(
    'refuses the wildcard %s: it is where a service LISTENS, never where anyone connects',
    (raw) => {
      const result = parsePublicUrl('--ui-public-url', raw)

      expect(result.ok).toBe(false)
      expect(!result.ok && result.message).toContain('wildcard')
    },
  )

  test('a refused value is echoed terminal-safe', () => {
    const result = parsePublicUrl('--ui-public-url', 'ftp://x\x1b[31m')

    expect(!result.ok && result.message).not.toContain('\x1b')
  })
})

describe('the derived entries are the ones the HTTP screen compares against', () => {
  // The contract between two modules that are otherwise tested apart: what
  // `setup` writes must be what a browser sends for that address.
  test.each([
    ['http://203.0.113.7:8091', '203.0.113.7:8091', 'http://203.0.113.7:8091'],
    ['https://MCP.Example.COM', 'mcp.example.com', 'https://mcp.example.com'],
    ['https://mcp.example.com:443', 'mcp.example.com', 'https://mcp.example.com'],
    ['http://[2001:db8::1]:8091', '[2001:db8::1]:8091', 'http://[2001:db8::1]:8091'],
    ['http://0xcb.0.0x71.7:8091', '203.0.113.7:8091', 'http://203.0.113.7:8091'],
  ])('%s', (raw, hostHeader, originHeader) => {
    const url = parsed(raw)
    const screen = { boundHost: '0.0.0.0', port: 8091, extraAllowed: [url.hostEntry] }

    expect(isHostAllowed(hostHeader, screen)).toBe(true)
    expect(isOriginAllowed(originHeader, [url.origin])).toBe(true)
    expect(isHostAllowed(`evil.example:8091`, screen)).toBe(false)
  })
})

describe('applyPublicUrl', () => {
  const LOOPBACK = { host: '127.0.0.1', port: 8091 }

  test('plain http to a public address: allow-lists filled, and the loopback bind opened to the network', () => {
    expect(applyPublicUrl(LOOPBACK, parsed('http://203.0.113.7:8091'), { isHostTyped: false, withOrigin: true })).toEqual({
      host: '0.0.0.0',
      port: 8091,
      allowedHosts: ['203.0.113.7:8091'],
      allowedOrigins: ['http://203.0.113.7:8091'],
    })
  })

  test('https means a TLS proxy in front: the bind is left where it was', () => {
    const next = applyPublicUrl(LOOPBACK, parsed('https://mcp.example.com'), { isHostTyped: false, withOrigin: true })

    expect(next.host).toBe('127.0.0.1')
    expect(next.allowedHosts).toEqual(['mcp.example.com'])
  })

  test('a bind the operator typed is never overruled', () => {
    const typed = { host: '10.0.0.5', port: 8091 }

    expect(applyPublicUrl(typed, parsed('http://203.0.113.7:8091'), { isHostTyped: true, withOrigin: true }).host).toBe('10.0.0.5')
  })

  test('an IPv6 address opens the IPv6 wildcard', () => {
    expect(applyPublicUrl(LOOPBACK, parsed('http://[2001:db8::1]:8091'), { isHostTyped: false, withOrigin: true }).host).toBe('::')
  })

  test('a loopback URL changes no bind', () => {
    expect(applyPublicUrl(LOOPBACK, parsed('http://localhost:8091'), { isHostTyped: false, withOrigin: true }).host).toBe('127.0.0.1')
  })

  test('entries an earlier run wrote are kept, and a repeat adds nothing twice', () => {
    const before = { ...LOOPBACK, allowedHosts: ['admin.internal'], allowedOrigins: ['https://admin.internal'] }
    const url = parsed('http://203.0.113.7:8091')

    const once = applyPublicUrl(before, url, { isHostTyped: false, withOrigin: true })
    const twice = applyPublicUrl(once, url, { isHostTyped: false, withOrigin: true })

    expect(once.allowedHosts).toEqual(['admin.internal', '203.0.113.7:8091'])
    expect(twice).toEqual(once)
    expect(before.allowedHosts).toEqual(['admin.internal'])
  })

  test('`serve` takes the Host entry only: agents are not browsers', () => {
    const next = applyPublicUrl({ host: '127.0.0.1', port: 8090 }, parsed('http://203.0.113.7:8090'), {
      isHostTyped: false,
      withOrigin: false,
    })

    expect(next.allowedHosts).toEqual(['203.0.113.7:8090'])
    expect('allowedOrigins' in next).toBe(false)
  })
})

describe('checkPublicUrl: what the setup transcript says about the address', () => {
  test('names every Host the front now answers to, so an address left behind by a move is visible', () => {
    const check = checkPublicUrl('ui', parsed('https://new.example.com'), ['old.example.com', 'new.example.com'])

    expect(check.detail).toContain('old.example.com, new.example.com')
  })

  test('plain http to a public address is a warning that says what travels in the clear and the two ways out', () => {
    const check = checkPublicUrl('ui', parsed('http://203.0.113.7:8091'))

    expect(check).toMatchObject({ name: 'ui address', level: 'warn' })
    expect(check.detail).toContain('http://203.0.113.7:8091')
    expect(check.detail).toContain('clear text')
    expect(check.detail).toContain('https://')
    expect(check.detail).toContain('ssh -L')
  })

  test('https, and http to loopback, are plain statements of where the service answers', () => {
    for (const raw of ['https://mcp.example.com', 'http://localhost:8091']) {
      const check = checkPublicUrl('ui', parsed(raw))

      expect([raw, check.level]).toEqual([raw, 'ok'])
      expect(check.detail).toContain(parsed(raw).origin)
    }
  })

  test('serve names agent keys, not admin tokens', () => {
    expect(checkPublicUrl('serve', parsed('http://203.0.113.7:8090')).detail).toContain('agent')
  })
})
