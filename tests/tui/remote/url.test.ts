import { describe, expect, test } from 'vitest'
import {
  isPlainHttpToNonLoopback,
  parseRemoteUrl,
  REMOTE_URL_ENV_VAR,
  resolveRemoteUrl,
} from '../../../src/tui/remote/url.js'

/**
 * `--remote <url>` / `MCPCUT_REMOTE` (ADR-0014, plan wave 2 task 1): what the
 * client accepts as the address of a `ui` service to drive, and what it
 * refuses outright rather than mis-send a request to.
 */

describe('parseRemoteUrl', () => {
  test('accepts a bare http origin', () => {
    const result = parseRemoteUrl('http://127.0.0.1:8091')

    expect(result).toEqual({
      ok: true,
      url: { origin: 'http://127.0.0.1:8091', hostname: '127.0.0.1', scheme: 'http', isLoopback: true },
    })
  })

  test('accepts https and normalises a trailing slash away', () => {
    const result = parseRemoteUrl('https://mcp.example.com/')

    expect(result).toEqual({
      ok: true,
      url: { origin: 'https://mcp.example.com', hostname: 'mcp.example.com', scheme: 'https', isLoopback: false },
    })
  })

  test.each([
    ['ftp://example.com', 'scheme'],
    ['example.com', 'scheme'],
    ['http://user:pass@example.com', 'credentials'],
    ['http://example.com/console', 'path'],
    ['http://example.com?x=1', 'query'],
    ['http://example.com#frag', 'fragment'],
    ['not a url at all http://', 'scheme'],
  ])('refuses %s (%s)', (raw) => {
    const result = parseRemoteUrl(raw)

    expect(result.ok).toBe(false)
  })

  test('a refusal names the flag and the value, never a stack', () => {
    const result = parseRemoteUrl('ftp://example.com')

    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('ftp://example.com')
  })
})

describe('resolveRemoteUrl: flag wins over env', () => {
  test('absent when neither is set: not remote mode at all', () => {
    expect(resolveRemoteUrl({ env: {} })).toBeUndefined()
  })

  test('env alone resolves', () => {
    const result = resolveRemoteUrl({ env: { [REMOTE_URL_ENV_VAR]: 'http://127.0.0.1:9' } })

    expect(result?.ok).toBe(true)
  })

  test('an empty env value is the same as unset', () => {
    expect(resolveRemoteUrl({ env: { [REMOTE_URL_ENV_VAR]: '' } })).toBeUndefined()
  })

  test('the flag overrides a set env var', () => {
    const result = resolveRemoteUrl({
      flag: 'https://flag.example.com',
      env: { [REMOTE_URL_ENV_VAR]: 'http://env.example.com' },
    })

    expect(result?.ok).toBe(true)
    expect(result?.ok === true && result.url.origin).toBe('https://flag.example.com')
  })

  test('a malformed flag is a refusal even when the env var is fine', () => {
    const result = resolveRemoteUrl({
      flag: 'not-a-url',
      env: { [REMOTE_URL_ENV_VAR]: 'http://env.example.com' },
    })

    expect(result?.ok).toBe(false)
  })
})

describe('isPlainHttpToNonLoopback', () => {
  test('true for http to a real host', () => {
    const parsed = parseRemoteUrl('http://203.0.113.7:8091')
    expect(parsed.ok && isPlainHttpToNonLoopback(parsed.url)).toBe(true)
  })

  test('false for http to loopback', () => {
    const parsed = parseRemoteUrl('http://127.0.0.1:8091')
    expect(parsed.ok && isPlainHttpToNonLoopback(parsed.url)).toBe(false)
  })

  test('false for https anywhere', () => {
    const parsed = parseRemoteUrl('https://203.0.113.7')
    expect(parsed.ok && isPlainHttpToNonLoopback(parsed.url)).toBe(false)
  })
})
