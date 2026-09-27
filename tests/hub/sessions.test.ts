import { describe, expect, test } from 'vitest'
import type { AccountRecord } from '../../hub/src/accounts-db.js'
import {
  HUB_SESSION_COOKIE_NAME,
  HUB_SESSION_IDLE_MS,
  HUB_SESSION_TTL_MS,
  clearHubSessionCookie,
  createHubSessions,
  serializeHubSessionCookie,
  sessionIdFromCookieHeader,
} from '../../hub/src/sessions.js'

/**
 * `hub/src/sessions.ts` (H2): in-memory sessions, 7 days absolute / 24 h idle,
 * a CSRF token per session, and a re-read of the account on every resolve —
 * a blocked or deleted account's session is dead on its very next request.
 */

const DAY_MS = 24 * 60 * 60 * 1000

function account(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    githubId: 42,
    login: 'alice',
    subdomain: 'alice',
    status: 'active',
    githubCreatedAt: '2019-01-01T00:00:00Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function setup(start = 1_000_000) {
  let now = start
  let stored: AccountRecord | null = account()
  const sessions = createHubSessions({
    findAccount: (githubId) => (stored !== null && stored.githubId === githubId ? stored : null),
    clock: () => now,
  })
  return {
    sessions,
    advance: (ms: number) => (now += ms),
    setAccount: (next: AccountRecord | null) => (stored = next),
  }
}

describe('create / resolve', () => {
  test('a created session resolves to the live account with its CSRF token', () => {
    const { sessions } = setup()
    const { sessionId, session } = sessions.create(account())

    const resolved = sessions.resolve(sessionId)

    expect(resolved).toEqual({ kind: 'live', session, account: account() })
    expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('no id or an unknown id resolves to none', () => {
    const { sessions } = setup()

    expect(sessions.resolve(undefined)).toEqual({ kind: 'none' })
    expect(sessions.resolve('x'.repeat(43))).toEqual({ kind: 'none' })
  })

  test('dies after 24 h without a request', () => {
    const { sessions, advance } = setup()
    const { sessionId } = sessions.create(account())

    advance(HUB_SESSION_IDLE_MS)

    expect(sessions.resolve(sessionId)).toEqual({ kind: 'none' })
    expect(sessions.size()).toBe(0)
  })

  test('activity keeps it alive, but never past 7 days', () => {
    const { sessions, advance } = setup()
    const { sessionId } = sessions.create(account())

    for (let day = 1; day < 7; day += 1) {
      advance(DAY_MS - 1)
      expect(sessions.resolve(sessionId).kind).toBe('live')
    }
    advance(HUB_SESSION_TTL_MS)

    expect(sessions.resolve(sessionId)).toEqual({ kind: 'none' })
  })

  test('a blocked account resolves as blocked and the session is gone', () => {
    const { sessions, setAccount } = setup()
    const { sessionId } = sessions.create(account())

    setAccount(account({ status: 'blocked' }))

    expect(sessions.resolve(sessionId)).toEqual({ kind: 'blocked' })
    expect(sessions.resolve(sessionId)).toEqual({ kind: 'none' })
  })

  test('a deleted account kills the session', () => {
    const { sessions, setAccount } = setup()
    const { sessionId } = sessions.create(account())

    setAccount(null)

    expect(sessions.resolve(sessionId)).toEqual({ kind: 'none' })
  })

  test('a re-created account with the same GitHub id does not inherit an old session', () => {
    const { sessions, setAccount } = setup()
    const { sessionId } = sessions.create(account())

    setAccount(account({ createdAt: '2026-11-01T00:00:00.000Z' }))

    expect(sessions.resolve(sessionId)).toEqual({ kind: 'none' })
  })
})

describe('destroy', () => {
  test('destroy ends one session; destroyAccount ends all of an account', () => {
    const { sessions } = setup()
    const first = sessions.create(account())
    const second = sessions.create(account())
    const third = sessions.create(account())

    sessions.destroy(first.sessionId)
    expect(sessions.resolve(first.sessionId).kind).toBe('none')
    expect(sessions.resolve(second.sessionId).kind).toBe('live')

    sessions.destroyAccount(42)
    expect(sessions.resolve(third.sessionId).kind).toBe('none')
    expect(sessions.size()).toBe(0)
  })

  test('destroy of an undefined id is a no-op', () => {
    const { sessions } = setup()

    expect(() => sessions.destroy(undefined)).not.toThrow()
  })
})

describe('caps', () => {
  test('a new sign-in past the per-account cap retires that account’s oldest session', () => {
    let now = 0
    const sessions = createHubSessions({
      findAccount: () => account(),
      clock: () => now,
      maxPerAccount: 2,
    })
    const first = sessions.create(account())
    now += 1
    const second = sessions.create(account())
    now += 1
    const third = sessions.create(account())

    expect(sessions.resolve(first.sessionId).kind).toBe('none')
    expect(sessions.resolve(second.sessionId).kind).toBe('live')
    expect(sessions.resolve(third.sessionId).kind).toBe('live')
  })

  test('the global cap retires the oldest session overall', () => {
    const sessions = createHubSessions({
      findAccount: (githubId) => account({ githubId }),
      clock: () => 0,
      maxSessions: 2,
    })
    const first = sessions.create(account({ githubId: 1 }))
    sessions.create(account({ githubId: 2 }))
    sessions.create(account({ githubId: 3 }))

    expect(sessions.resolve(first.sessionId).kind).toBe('none')
    expect(sessions.size()).toBe(2)
  })
})

describe('cookie', () => {
  test('serializes a __Host- cookie: HttpOnly, Secure, SameSite=Strict, Path=/, 7-day Max-Age', () => {
    const id = 'a'.repeat(43)

    const cookie = serializeHubSessionCookie(id)

    expect(cookie).toBe(`__Host-mcpcut_hub=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`)
    expect(HUB_SESSION_COOKIE_NAME).toBe('__Host-mcpcut_hub')
  })

  test('refuses to serialize a value that could smuggle attributes', () => {
    expect(() => serializeHubSessionCookie('abc; Domain=evil.com')).toThrow(TypeError)
  })

  test('clears with Max-Age=0', () => {
    expect(clearHubSessionCookie()).toBe('__Host-mcpcut_hub=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0')
  })

  test('reads the id from a Cookie header; ambiguous or malformed reads as absent', () => {
    const id = 'b'.repeat(43)
    const other = 'c'.repeat(43)

    expect(sessionIdFromCookieHeader(`x=1; __Host-mcpcut_hub=${id}`)).toBe(id)
    expect(sessionIdFromCookieHeader(undefined)).toBeUndefined()
    expect(sessionIdFromCookieHeader('__Host-mcpcut_hub=short')).toBeUndefined()
    expect(sessionIdFromCookieHeader(`__Host-mcpcut_hub=${id}; __Host-mcpcut_hub=${other}`)).toBeUndefined()
    expect(sessionIdFromCookieHeader(`mcpcut_hub=${id}`)).toBeUndefined()
  })
})
