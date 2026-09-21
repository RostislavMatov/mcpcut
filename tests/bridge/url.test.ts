import { describe, expect, test } from 'vitest'
import { BRIDGE_POOL_PATH } from '../../src/bridge/constants.js'
import { checkBridgeScheme, parseBridgeUrl } from '../../src/bridge/url.js'

/**
 * The address `connect --url` takes (plan task 2; owner decisions PE5, PE8).
 *
 * Two rules distinguish it from `--remote`'s address (`tui/remote/url.ts`):
 * a PATH is allowed — that is the per-server address of PE4 — and a bare
 * origin means the pool endpoint, which the bridge appends itself because
 * PE5 made that path an internal detail the operator never types.
 */

/** Unwraps a result the test expects to be accepted, with a loud failure if it is not. */
function accepted(raw: string) {
  const result = parseBridgeUrl(raw)
  if (!result.ok) throw new Error(`"${raw}" was refused: ${result.message}`)
  return result.url
}

describe('parseBridgeUrl: a bare origin means the pool endpoint (PE5)', () => {
  test.each(['https://plane.example:8090', 'https://plane.example:8090/'])(
    '%s gets the pool path appended',
    (raw) => {
      const url = accepted(raw)

      expect(url.endpoint).toBe(`https://plane.example:8090${BRIDGE_POOL_PATH}`)
      expect(url.isPoolAddress).toBe(true)
      expect(url.origin).toBe('https://plane.example:8090')
    },
  )

  test('the origin carries no path, so messages about it never leak one', () => {
    expect(accepted('https://plane.example:8090/agents/a/servers/s').origin).toBe(
      'https://plane.example:8090',
    )
  })
})

describe('parseBridgeUrl: an explicit path is used as given (PE4)', () => {
  test('a per-server address is left alone', () => {
    const url = accepted('http://127.0.0.1:8090/agents/reader/servers/files')

    expect(url.endpoint).toBe('http://127.0.0.1:8090/agents/reader/servers/files')
    expect(url.isPoolAddress).toBe(false)
  })

  test('one trailing slash is dropped, and nothing else about the path is touched', () => {
    expect(accepted('http://127.0.0.1:8090/agents/a/servers/s/').endpoint).toBe(
      'http://127.0.0.1:8090/agents/a/servers/s',
    )
    // The front does not decode its own path (`routes.ts`), so neither does this.
    expect(accepted('http://127.0.0.1:8090/agents/a%2Fb/servers/s').endpoint).toBe(
      'http://127.0.0.1:8090/agents/a%2Fb/servers/s',
    )
  })

  test('a path of its own does not turn into the pool address', () => {
    expect(accepted('https://plane.example/mcp').isPoolAddress).toBe(false)
  })
})

describe('parseBridgeUrl: loopback is recognized in every spelling', () => {
  test.each([
    ['http://127.0.0.1:8090', true],
    ['http://127.9.9.9:1/x', true],
    ['http://localhost:8090', true],
    ['http://[::1]:1/x', true],
    ['http://10.0.0.5:8090', false],
    ['https://plane.example', false],
  ] as const)('%s → isLoopback %s', (raw, expected) => {
    expect(accepted(raw).isLoopback).toBe(expected)
  })

  test.each([
    'http://127.evil.com:8090',
    'http://127.0.0.1.attacker.example:8090',
    'http://localhost.attacker.example:8090',
  ])('%s is NOT loopback — a name that merely looks like one owns its own DNS', (raw) => {
    // Security review 2026-09-21, CRITICAL: these matched a `'127.'` string
    // prefix and skipped PE8 entirely, so the agent token went to an
    // attacker's host in clear with no warning and no flag.
    const url = accepted(raw)

    expect(url.isLoopback).toBe(false)
    expect(checkBridgeScheme(url, false)).toBe('refuse')
    expect(checkBridgeScheme(url, true)).toBe('warn')
  })

  test('the scheme is reported as the two words the rest of the bridge switches on', () => {
    expect(accepted('https://plane.example').scheme).toBe('https')
    expect(accepted('http://127.0.0.1:1').scheme).toBe('http')
  })
})

describe('parseBridgeUrl: what it refuses, and why', () => {
  test.each([
    ['plane.example:8090', 'not a URL'],
    ['ftp://plane.example', 'http'],
    ['/agents/a/servers/s', 'not a URL'],
    ['', 'not a URL'],
    ['https://plane.example/?agent=a', 'query'],
    ['https://plane.example/#frag', 'fragment'],
  ])('refuses %s, saying something about %s', (raw, hint) => {
    const result = parseBridgeUrl(raw)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain(hint)
    expect(result.message.endsWith('\n')).toBe(true)
  })

  test('refuses credentials in the address WITHOUT echoing them', () => {
    const result = parseBridgeUrl('https://agent:mcpj_secret-in-url@plane.example/mcp')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('credentials')
    // The whole point: a token pasted into the address must not come back out
    // on stderr, where a client will log it.
    expect(result.message).not.toContain('mcpj_secret-in-url')
    expect(result.message).not.toContain('agent:')
    expect(result.message).toContain('plane.example')
  })

  test.each([
    ['a query', 'https://plane.example/mcp?access_token=SECRET-VALUE-1'],
    ['a fragment', 'https://plane.example/mcp#id_token=SECRET-VALUE-1'],
  ])('refuses %s without echoing what was in it', (_name, raw) => {
    // A query or a fragment is where an OAuth-shaped secret lands, and this
    // message goes to a stderr an MCP client writes to a log file. The
    // argv screen upstream only knows this project's own `mcpj_` prefix, so
    // the refusal itself must not repeat the value (security review
    // 2026-09-21, MEDIUM).
    const result = parseBridgeUrl(raw)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).not.toContain('SECRET-VALUE-1')
    expect(result.message).toContain('plane.example')
  })

  test('a refusal that DOES echo the value strips control characters from it', () => {
    // argv can hold terminal escapes, and a refusal that replayed them could
    // rewrite or hide the very line it is trying to show (security review
    // 2026-09-21, LOW; the precedent is the H2 fix for tool names).
    const result = parseBridgeUrl('ftp://plane\u001b[2Kexample\u0007')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).not.toContain('\u001b')
    expect(result.message).not.toContain('\u0007')
  })

  test('and caps an absurdly long one rather than filling the terminal', () => {
    const result = parseBridgeUrl(`ftp://${'a'.repeat(5000)}`)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message.length).toBeLessThan(400)
  })

  test.each(['http://', 'https://', 'http:// ', 'https://:8090'])(
    'refuses %s — a scheme with no host behind it',
    (raw) => {
      const result = parseBridgeUrl(raw)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain('not a URL')
    },
  )

  test('names the flag, so the operator knows which argument is wrong', () => {
    const result = parseBridgeUrl('ftp://plane.example')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('--url')
  })
})

describe('checkBridgeScheme: plain http off this machine is a refusal (PE8)', () => {
  test('https is always fine', () => {
    expect(checkBridgeScheme(accepted('https://plane.example'), false)).toBe('ok')
  })

  test.each(['http://127.0.0.1:8090', 'http://localhost:8090/mcp', 'http://[::1]:1'])(
    'plain http to %s needs no flag — no other host can reach it',
    (raw) => {
      expect(checkBridgeScheme(accepted(raw), false)).toBe('ok')
    },
  )

  test('plain http to another host is refused without the flag', () => {
    expect(checkBridgeScheme(accepted('http://10.0.0.5:8090'), false)).toBe('refuse')
  })

  test('the flag downgrades that refusal to a warning, never to silence', () => {
    expect(checkBridgeScheme(accepted('http://10.0.0.5:8090'), true)).toBe('warn')
  })

  test('the flag changes nothing where nothing was wrong', () => {
    expect(checkBridgeScheme(accepted('https://plane.example'), true)).toBe('ok')
    expect(checkBridgeScheme(accepted('http://127.0.0.1:1'), true)).toBe('ok')
  })
})
