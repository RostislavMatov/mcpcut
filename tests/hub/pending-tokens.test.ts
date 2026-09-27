import { describe, expect, test } from 'vitest'
import { createPendingTokens, PENDING_TOKEN_TTL_MS } from '../../hub/src/pending-tokens.js'

/**
 * The hub's in-memory hand-over of a fresh owner token (plan
 * `hosted-path-and-ops`, Task A, P2/P3): an install created in the background
 * leaves its first owner token here until `/account` takes it — once — and a
 * failed creation leaves a one-time mark instead.
 */

const ALICE = { githubId: 1, accountCreatedAt: '2026-09-27T10:00:00.000Z' }
const TOKEN = 'mcpa_pendingTokenValue0123456789'

function store(options: { maxEntries?: number } = {}): { tokens: ReturnType<typeof createPendingTokens>; advance(ms: number): void } {
  let now = Date.parse('2026-09-27T10:00:00.000Z')
  const tokens = createPendingTokens({ clock: () => now, ...options })
  return { tokens, advance: (ms) => (now += ms) }
}

describe('owner tokens', () => {
  test('are handed out once: the second take finds nothing', () => {
    const { tokens } = store()
    tokens.putToken(ALICE, TOKEN)

    expect(tokens.takeToken(ALICE)).toBe(TOKEN)
    expect(tokens.takeToken(ALICE)).toBeUndefined()
    expect(tokens.size()).toBe(0)
  })

  test('belong to one account generation: a re-created account does not get the old token', () => {
    const { tokens } = store()
    tokens.putToken(ALICE, TOKEN)

    expect(tokens.takeToken({ ...ALICE, accountCreatedAt: '2026-10-01T00:00:00.000Z' })).toBeUndefined()
    expect(tokens.takeToken(ALICE)).toBeUndefined()
  })

  test('expire after 15 minutes', () => {
    const { tokens, advance } = store()
    tokens.putToken(ALICE, TOKEN)

    advance(PENDING_TOKEN_TTL_MS)

    expect(tokens.takeToken(ALICE)).toBeUndefined()
  })

  test('are still there a moment before the TTL', () => {
    const { tokens, advance } = store()
    tokens.putToken(ALICE, TOKEN)

    advance(PENDING_TOKEN_TTL_MS - 1)

    expect(tokens.takeToken(ALICE)).toBe(TOKEN)
  })

  test('are capped: the oldest entry goes first', () => {
    const { tokens } = store({ maxEntries: 2 })
    tokens.putToken({ githubId: 1, accountCreatedAt: 'a' }, 'mcpa_one_0123456789abcdef')
    tokens.putToken({ githubId: 2, accountCreatedAt: 'b' }, 'mcpa_two_0123456789abcdef')
    tokens.putToken({ githubId: 3, accountCreatedAt: 'c' }, 'mcpa_three_0123456789abcd')

    expect(tokens.size()).toBe(2)
    expect(tokens.takeToken({ githubId: 1, accountCreatedAt: 'a' })).toBeUndefined()
    expect(tokens.takeToken({ githubId: 3, accountCreatedAt: 'c' })).toBe('mcpa_three_0123456789abcd')
  })

  test('forget drops whatever waits for an account', () => {
    const { tokens } = store()
    tokens.putToken(ALICE, TOKEN)
    tokens.markFailed({ githubId: 1, accountCreatedAt: 'older' })

    tokens.forget(ALICE.githubId)

    expect(tokens.takeToken(ALICE)).toBeUndefined()
    expect(tokens.takeFailed({ githubId: 1, accountCreatedAt: 'older' })).toBe(false)
  })

  test('the store itself never renders a token', () => {
    const { tokens } = store()
    tokens.putToken(ALICE, TOKEN)

    expect(JSON.stringify(tokens)).not.toContain(TOKEN)
    expect(String(tokens)).not.toContain(TOKEN)
  })
})

describe('failure marks', () => {
  test('are read once', () => {
    const { tokens } = store()
    tokens.markFailed(ALICE)

    expect(tokens.takeFailed(ALICE)).toBe(true)
    expect(tokens.takeFailed(ALICE)).toBe(false)
  })

  test('belong to one account generation', () => {
    const { tokens } = store()
    tokens.markFailed(ALICE)

    expect(tokens.takeFailed({ ...ALICE, accountCreatedAt: 'another' })).toBe(false)
  })

  test('expire after the same TTL', () => {
    const { tokens, advance } = store()
    tokens.markFailed(ALICE)

    advance(PENDING_TOKEN_TTL_MS)

    expect(tokens.takeFailed(ALICE)).toBe(false)
  })

  test('a failure clears a token still waiting for the same account, and the other way round', () => {
    const { tokens } = store()
    tokens.putToken(ALICE, TOKEN)
    tokens.markFailed(ALICE)
    expect(tokens.takeToken(ALICE)).toBeUndefined()

    tokens.putToken(ALICE, TOKEN)
    expect(tokens.takeFailed(ALICE)).toBe(false)
  })
})

describe('options', () => {
  test('refuse a cap below one', () => {
    expect(() => createPendingTokens({ maxEntries: 0 })).toThrow(RangeError)
  })
})
