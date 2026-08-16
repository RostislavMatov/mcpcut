import { describe, expect, test } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { AdminRecord } from '../../src/admin/store.js'
import { createLoginRateLimiter, createSessionManager, loginRateLimitKey } from '../../src/ui/auth.js'
import {
  LOGIN_GLOBAL_PENALTY_DELAY_MS,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_OWNER_RESERVED_SLOTS,
} from '../../src/ui/constants.js'

/**
 * Availability of the admin plane's login path (post-M4.5 hardening wave 1).
 *
 * Every case here is a DENIAL OF SERVICE reachable by a party who is not
 * supposed to have it — a low-privilege admin, a forgotten browser tab, or an
 * unauthenticated local process. The M4 smoke reproduced the first one live:
 * eight viewer sessions filled the pool and the owner could not log in until
 * the 8-hour TTL expired.
 *
 * The security property these must not trade away: a live session is still
 * NEVER evicted to make room for a new one.
 */

let counter = 0

function admin(name: string, role: AdminRecord['role']): AdminRecord {
  counter += 1
  return {
    name,
    role,
    tokenHash: `${counter}`.padStart(64, '0'),
    createdAt: '2026-08-16T00:00:00.000Z',
  }
}

/** An `AdminResolver` that always confirms the admins it was built with. */
function resolverFor(...admins: readonly AdminRecord[]) {
  const byName = new Map(admins.map((a) => [a.name, a]))
  return {
    findAdminByToken: async () => undefined,
    getActiveAdmin: async (name: string) => byName.get(name),
  }
}

describe('owner slot reserve (M4 smoke: viewers locked the owner out)', () => {
  test('non-owner logins stop at the pool minus the reserve; the owner still gets in', () => {
    const sessions = createSessionManager({ maxSessions: 64 })
    const nonOwnerCap = 64 - SESSION_OWNER_RESERVED_SLOTS

    // Seven viewers × eight sessions each fill every unreserved slot.
    let admitted = 0
    for (let i = 0; i < nonOwnerCap; i += 1) {
      const created = sessions.create(admin(`viewer-${i}`, 'viewer'))
      if (created.ok) admitted += 1
    }
    expect(admitted).toBe(nonOwnerCap)

    // The next non-owner is refused — the remaining slots are not theirs.
    const refused = sessions.create(admin('viewer-late', 'viewer'))
    expect(refused.ok).toBe(false)

    // The owner walks into the reserve.
    for (let i = 0; i < SESSION_OWNER_RESERVED_SLOTS; i += 1) {
      expect(sessions.create(admin(`owner-${i}`, 'owner')).ok, `owner login #${i + 1}`).toBe(true)
    }
    expect(sessions.size()).toBe(64)
  })

  test('the owner is refused too once the whole pool is full — no live session is evicted', () => {
    const sessions = createSessionManager({ maxSessions: 64 })
    for (let i = 0; i < 64; i += 1) sessions.create(admin(`owner-${i}`, 'owner'))

    const refused = sessions.create(admin('owner-last', 'owner'))

    expect(refused.ok).toBe(false)
    expect(sessions.size()).toBe(64)
  })

  test('a refusal for the reserve is indistinguishable to the caller from any other cap', () => {
    const sessions = createSessionManager({ maxSessions: 64 })
    for (let i = 0; i < 64 - SESSION_OWNER_RESERVED_SLOTS; i += 1) {
      sessions.create(admin(`viewer-${i}`, 'viewer'))
    }

    const refused = sessions.create(admin('viewer-late', 'viewer'))

    // The reason exists for the stderr diagnostic only; the HTTP answer is the
    // same byte-identical 429 as every other cap (no capacity oracle).
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe('reserved-for-owner')
  })

  test('the reserve never takes more than an eighth of the pool', () => {
    // A tiny pool (tests, or a deliberately small deployment) must degrade to
    // the old behaviour rather than to an owner-only plane.
    const sessions = createSessionManager({ maxSessions: 2 })

    expect(sessions.create(admin('viewer-a', 'viewer')).ok).toBe(true)
    expect(sessions.create(admin('viewer-b', 'viewer')).ok).toBe(true)
    expect(sessions.create(admin('viewer-c', 'viewer')).ok).toBe(false)
  })
})

describe('session idle timeout (frees slots a forgotten tab is sitting on)', () => {
  test('a session idle longer than the idle window stops resolving', async () => {
    let now = 1_000_000
    const owner = admin('owner', 'owner')
    const sessions = createSessionManager({
      clock: () => now,
      ttlMs: SESSION_IDLE_TIMEOUT_MS * 100,
      idleTimeoutMs: 1000,
    })
    const created = sessions.create(owner)
    if (!created.ok) throw new Error('expected the login to succeed')

    now += 1001

    expect(await sessions.resolve(created.sessionId, resolverFor(owner))).toBeUndefined()
    expect(sessions.size()).toBe(0)
  })

  test('activity refreshes the idle window', async () => {
    let now = 1_000_000
    const owner = admin('owner', 'owner')
    const resolver = resolverFor(owner)
    const sessions = createSessionManager({
      clock: () => now,
      ttlMs: SESSION_IDLE_TIMEOUT_MS * 100,
      idleTimeoutMs: 1000,
    })
    const created = sessions.create(owner)
    if (!created.ok) throw new Error('expected the login to succeed')

    for (let i = 0; i < 5; i += 1) {
      now += 900
      expect(await sessions.resolve(created.sessionId, resolver), `request #${i + 1}`).toBeDefined()
    }
  })

  test('the absolute TTL still caps a continuously active session', async () => {
    let now = 1_000_000
    const owner = admin('owner', 'owner')
    const resolver = resolverFor(owner)
    const sessions = createSessionManager({ clock: () => now, ttlMs: 5000, idleTimeoutMs: 1000 })
    const created = sessions.create(owner)
    if (!created.ok) throw new Error('expected the login to succeed')

    for (let i = 0; i < 5; i += 1) {
      now += 900
      await sessions.resolve(created.sessionId, resolver)
    }
    now += 900

    // Active the whole time, but past the absolute lifetime: a stolen cookie
    // must not be refreshable into an unbounded one.
    expect(await sessions.resolve(created.sessionId, resolver)).toBeUndefined()
  })

  test('a heartbeat liveness probe is not activity', async () => {
    let now = 1_000_000
    const owner = admin('owner', 'owner')
    const resolver = resolverFor(owner)
    const sessions = createSessionManager({
      clock: () => now,
      ttlMs: SESSION_IDLE_TIMEOUT_MS * 100,
      idleTimeoutMs: 1000,
    })
    const created = sessions.create(owner)
    if (!created.ok) throw new Error('expected the login to succeed')

    // An open SSE stream probes `isLive` every 15s. If that counted as
    // activity, one forgotten tab would hold its slot until the absolute TTL —
    // exactly the state the idle timeout exists to end.
    for (let i = 0; i < 3; i += 1) {
      now += 400
      await sessions.isLive(created.sessionId, resolver)
    }
    now += 400

    expect(await sessions.isLive(created.sessionId, resolver)).toBe(false)
  })
})

describe('rate-limit key behind a reverse proxy', () => {
  function reqWith(headers: Record<string, string>, remoteAddress = '10.9.9.9'): IncomingMessage {
    return { headers, socket: { remoteAddress } } as unknown as IncomingMessage
  }

  test('without the flag the key is the peer address, and a client-supplied header is ignored', () => {
    const req = reqWith({ 'x-forwarded-for': '1.2.3.4' })

    expect(loginRateLimitKey(req)).toBe('10.9.9.9')
  })

  test('with the flag the key is the RIGHTMOST element of the trusted header', () => {
    // A client that pre-populates the header gets its value pushed left by the
    // proxy's append; the rightmost element is the one the trusted hop wrote.
    const req = reqWith({ 'x-forwarded-for': 'spoofed, 203.0.113.7' })

    expect(loginRateLimitKey(req, 'x-forwarded-for')).toBe('203.0.113.7')
  })

  test('a single-value trusted header (proxy overwrites rather than appends) is used as-is', () => {
    expect(loginRateLimitKey(reqWith({ 'x-forwarded-for': '203.0.113.7' }), 'x-forwarded-for')).toBe(
      '203.0.113.7',
    )
  })

  test('a missing or empty trusted header falls back to the peer address', () => {
    expect(loginRateLimitKey(reqWith({}), 'x-forwarded-for')).toBe('10.9.9.9')
    expect(loginRateLimitKey(reqWith({ 'x-forwarded-for': '  ,  ' }), 'x-forwarded-for')).toBe(
      '10.9.9.9',
    )
  })

  test('the header name is matched case-insensitively', () => {
    const req = reqWith({ 'x-real-ip': '203.0.113.8' })

    expect(loginRateLimitKey(req, 'X-Real-IP')).toBe('203.0.113.8')
  })
})

describe('the global login ceiling degrades to delay, not refusal', () => {
  test('past the ceiling attempts are still served — the ceiling is not a lockout primitive', () => {
    const limiter = createLoginRateLimiter({ maxFailures: 3, globalMaxFailures: 10, windowMs: 60_000 })
    for (let i = 0; i < 20; i += 1) limiter.recordFailure(`10.0.0.${i}`)

    // Old behaviour refused here, which handed any local process able to reach
    // `/login` from 127.0.0.0/8 aliases a way to lock every admin out.
    expect(limiter.allow('10.0.0.250')).toBe(true)
  })

  test('past the ceiling every attempt is penalised with a delay', () => {
    const limiter = createLoginRateLimiter({ maxFailures: 3, globalMaxFailures: 10, windowMs: 60_000 })
    expect(limiter.penaltyMs('10.0.0.250')).toBe(0)

    for (let i = 0; i < 10; i += 1) limiter.recordFailure(`10.0.0.${i}`)

    expect(limiter.penaltyMs('10.0.0.250')).toBe(LOGIN_GLOBAL_PENALTY_DELAY_MS)
  })

  test('the per-address window still refuses outright — that lockout is self-inflicted', () => {
    const limiter = createLoginRateLimiter({ maxFailures: 2, globalMaxFailures: 1000, windowMs: 60_000 })
    limiter.recordFailure('10.0.0.1')
    limiter.recordFailure('10.0.0.1')

    expect(limiter.allow('10.0.0.1')).toBe(false)
    expect(limiter.allow('10.0.0.2')).toBe(true)
  })

  test('the penalty lapses with the window', () => {
    let now = 1_000_000
    const limiter = createLoginRateLimiter({
      maxFailures: 3,
      globalMaxFailures: 5,
      windowMs: 1000,
      clock: () => now,
    })
    for (let i = 0; i < 5; i += 1) limiter.recordFailure(`10.0.0.${i}`)
    expect(limiter.penaltyMs('10.0.0.250')).toBe(LOGIN_GLOBAL_PENALTY_DELAY_MS)

    now += 2000

    expect(limiter.penaltyMs('10.0.0.250')).toBe(0)
  })
})
