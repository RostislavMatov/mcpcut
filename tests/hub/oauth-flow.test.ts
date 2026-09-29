import { describe, expect, test } from 'vitest'
import {
  OAUTH_FLOW_COOKIE_NAME,
  OAUTH_FLOW_MAX_ENTRIES,
  OAUTH_FLOW_TTL_MS,
  clearFlowCookie,
  createOauthFlows,
  flowIdFromCookieHeader,
  pkceChallengeOf,
  serializeFlowCookie,
} from '../../hub/src/oauth-flow.js'
import { s256 } from './fake-github.js'

const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/

function manualClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

describe('PKCE', () => {
  test('pkceChallengeOf matches the RFC 7636 Appendix B test vector', () => {
    // Arrange
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'

    // Act
    const challenge = pkceChallengeOf(verifier)

    // Assert
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})

describe('createOauthFlows', () => {
  test('begin returns a fresh flow id, state and S256 challenge, never the verifier', () => {
    const flows = createOauthFlows()

    const first = flows.begin()
    const second = flows.begin()

    expect(Object.keys(first).sort()).toEqual(['challenge', 'flowId', 'state'])
    for (const value of [first.flowId, first.state, first.challenge]) expect(value).toMatch(BASE64URL_43)
    expect(second.flowId).not.toBe(first.flowId)
    expect(second.state).not.toBe(first.state)
    expect(second.challenge).not.toBe(first.challenge)
  })

  test('complete hands out the verifier whose S256 is the challenge', () => {
    const flows = createOauthFlows()
    const started = flows.begin()

    const result = flows.complete({ flowId: started.flowId, state: started.state })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.verifier).toMatch(BASE64URL_43)
    expect(s256(result.verifier)).toBe(started.challenge)
  })

  test('a flow completes once: a replayed callback is refused', () => {
    const flows = createOauthFlows()
    const started = flows.begin()
    flows.complete({ flowId: started.flowId, state: started.state })

    const replay = flows.complete({ flowId: started.flowId, state: started.state })

    expect(replay).toEqual({ ok: false, reason: 'unknown-flow' })
  })

  test('a wrong state is refused and burns the flow', () => {
    const flows = createOauthFlows()
    const started = flows.begin()

    const lastChar = started.state.at(-1) === 'A' ? 'B' : 'A'
    const wrong = flows.complete({ flowId: started.flowId, state: `${started.state.slice(0, -1)}${lastChar}` })
    const retry = flows.complete({ flowId: started.flowId, state: started.state })

    expect(wrong).toEqual({ ok: false, reason: 'state-mismatch' })
    expect(retry).toEqual({ ok: false, reason: 'unknown-flow' })
  })

  test("another flow's cookie with this state is refused (login CSRF)", () => {
    const flows = createOauthFlows()
    const victim = flows.begin()
    const attacker = flows.begin()

    const result = flows.complete({ flowId: victim.flowId, state: attacker.state })

    expect(result).toEqual({ ok: false, reason: 'state-mismatch' })
  })

  test('a state of a different length is refused without throwing', () => {
    const flows = createOauthFlows()
    const started = flows.begin()

    expect(flows.complete({ flowId: started.flowId, state: 'short' })).toEqual({ ok: false, reason: 'state-mismatch' })
  })

  test('a missing cookie or state is refused', () => {
    const flows = createOauthFlows()
    const started = flows.begin()

    expect(flows.complete({ flowId: undefined, state: started.state })).toEqual({ ok: false, reason: 'missing' })
    expect(flows.complete({ flowId: started.flowId, state: undefined })).toEqual({ ok: false, reason: 'missing' })
    expect(flows.complete({ flowId: started.flowId, state: '' })).toEqual({ ok: false, reason: 'missing' })
  })

  test('an unknown flow id is refused', () => {
    const flows = createOauthFlows()

    expect(flows.complete({ flowId: 'x'.repeat(43), state: 'y'.repeat(43) })).toEqual({
      ok: false,
      reason: 'unknown-flow',
    })
  })

  test('a flow lives ten minutes: just inside is accepted, at the TTL it is expired', () => {
    const clock = manualClock()
    const flows = createOauthFlows({ clock: clock.now })
    const inside = flows.begin()
    const outside = flows.begin()

    clock.advance(OAUTH_FLOW_TTL_MS - 1)
    const accepted = flows.complete({ flowId: inside.flowId, state: inside.state })
    clock.advance(1)
    const expired = flows.complete({ flowId: outside.flowId, state: outside.state })

    expect(OAUTH_FLOW_TTL_MS).toBe(10 * 60 * 1000)
    expect(accepted.ok).toBe(true)
    expect(expired).toEqual({ ok: false, reason: 'expired' })
    expect(flows.size()).toBe(0)
  })

  test('begin sweeps expired flows so abandoned sign-ins do not pile up', () => {
    const clock = manualClock()
    const flows = createOauthFlows({ clock: clock.now })
    flows.begin()
    flows.begin()

    clock.advance(OAUTH_FLOW_TTL_MS)
    flows.begin()

    expect(flows.size()).toBe(1)
  })

  test('at the ceiling the oldest flow is evicted, newer ones survive', () => {
    const flows = createOauthFlows({ maxEntries: 3 })
    const oldest = flows.begin()
    const kept = [flows.begin(), flows.begin()]

    const newest = flows.begin()

    expect(flows.size()).toBe(3)
    expect(flows.complete({ flowId: oldest.flowId, state: oldest.state })).toEqual({ ok: false, reason: 'unknown-flow' })
    for (const flow of [...kept, newest]) expect(flows.complete({ flowId: flow.flowId, state: flow.state }).ok).toBe(true)
  })

  test('the default ceiling is ten thousand flows', () => {
    expect(OAUTH_FLOW_MAX_ENTRIES).toBe(10_000)
  })

  test.each([
    [{ ttlMs: 0 }],
    [{ ttlMs: Number.NaN }],
    [{ maxEntries: 0 }],
    [{ maxEntries: 1.5 }],
  ])('rejects a nonsensical option %o', (options) => {
    expect(() => createOauthFlows(options)).toThrow(/createOauthFlows/)
  })
})

describe('flow cookie', () => {
  const flowId = 'a'.repeat(21) + '-_' + 'B'.repeat(20)

  test('the cookie is __Host- scoped, HttpOnly, Secure, SameSite=Lax, ten minutes', () => {
    expect(OAUTH_FLOW_COOKIE_NAME).toBe('__Host-mcpcut_oauth')
    expect(serializeFlowCookie(flowId)).toBe(
      `__Host-mcpcut_oauth=${flowId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    )
  })

  test('the clearing cookie keeps the attributes and expires at once', () => {
    expect(clearFlowCookie()).toBe('__Host-mcpcut_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0')
  })

  test('serializeFlowCookie refuses a value that is not a flow id', () => {
    expect(() => serializeFlowCookie('a; Domain=evil.test')).toThrow(/flow id/)
  })

  test('reads the flow id among other cookies', () => {
    const header = `theme=dark; ${OAUTH_FLOW_COOKIE_NAME}=${flowId}; __Host-mcpcut_hub=zzz`

    expect(flowIdFromCookieHeader(header)).toBe(flowId)
  })

  test('the same cookie twice with the same value is read', () => {
    expect(flowIdFromCookieHeader(`${OAUTH_FLOW_COOKIE_NAME}=${flowId}; ${OAUTH_FLOW_COOKIE_NAME}=${flowId}`)).toBe(flowId)
  })

  test.each([
    ['no header', undefined],
    ['empty header', ''],
    ['other cookies only', 'a=b; c=d'],
    ['empty value', `${OAUTH_FLOW_COOKIE_NAME}=`],
    ['wrong length', `${OAUTH_FLOW_COOKIE_NAME}=abc`],
    ['forbidden characters', `${OAUTH_FLOW_COOKIE_NAME}=${'a'.repeat(42)}!`],
    ['a prefix-less name', `mcpcut_oauth=${flowId}`],
    ['two different values', `${OAUTH_FLOW_COOKIE_NAME}=${flowId}; ${OAUTH_FLOW_COOKIE_NAME}=${'c'.repeat(43)}`],
  ])('reads nothing from %s', (_label, header) => {
    expect(flowIdFromCookieHeader(header)).toBeUndefined()
  })

  test('a flow id from begin survives the cookie round trip', () => {
    const flows = createOauthFlows()
    const started = flows.begin()
    const setCookie = serializeFlowCookie(started.flowId)
    const cookieHeader = setCookie.split(';')[0] as string

    expect(flowIdFromCookieHeader(cookieHeader)).toBe(started.flowId)
  })
})
