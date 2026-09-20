import { describe, expect, test } from 'vitest'
import { createLoginRateLimiter } from '../../src/ui/auth.js'

/**
 * `LoginRateLimiter.recordAuthenticated` (ADR-0014 review, MEDIUM/HIGH): the
 * console API's `resolveConsoleBearer` provisionally counts EVERY request
 * against the shared GLOBAL window before the token is even looked up — the
 * same ordering discipline `/login` uses (`login-flow.ts`). `/login`'s own
 * `recordSuccess` deliberately does NOT forgive that global count (its doc
 * comment explains why: the global window counts admitted attempts). But the
 * console API's bearer is not a human typing a password at a rate a person
 * can sustain — it is *every* console request, including the automatic
 * background ones (`refresh-services`, the Approvals poll) — so leaving a
 * successful one in the global window for a full `windowMs` means roughly a
 * hundred ordinary requests are enough to make every `/login` AND every
 * console request pay the global penalty behind them.
 *
 * `recordAuthenticated` clears the key's own window (like `recordSuccess`)
 * and additionally removes exactly the ONE global entry this specific
 * request's own `recordFailure` added — never a different key's entry, and
 * never more than one, even when other attempts are interleaved with this
 * one's own `await`s.
 */

describe('recordAuthenticated: the per-key window', () => {
  test('clears the key exactly as `recordSuccess` does — the key is allowed again immediately', () => {
    const limiter = createLoginRateLimiter({ maxFailures: 2, windowMs: 60_000 })
    limiter.recordFailure('k')
    limiter.recordFailure('k')
    expect(limiter.allow('k')).toBe(false)

    limiter.recordAuthenticated('k')

    expect(limiter.allow('k')).toBe(true)
  })
})

describe('recordAuthenticated: the global window', () => {
  test('removes the one global entry this key just added, so penaltyMs returns to 0', () => {
    const limiter = createLoginRateLimiter({ globalMaxFailures: 1, windowMs: 60_000 })
    limiter.recordFailure('k')
    expect(limiter.penaltyMs('anyone')).toBeGreaterThan(0)

    limiter.recordAuthenticated('k')

    expect(limiter.penaltyMs('anyone')).toBe(0)
  })

  test('300 successful console resolutions (recordFailure then recordAuthenticated, as resolveConsoleBearer does) leave penaltyMs at 0', () => {
    const limiter = createLoginRateLimiter({ globalMaxFailures: 5, windowMs: 60_000 })

    for (let i = 0; i < 300; i += 1) {
      const key = `10.0.0.${i % 7}`
      limiter.recordFailure(key)
      limiter.recordAuthenticated(key)
    }

    expect(limiter.penaltyMs('10.0.0.250')).toBe(0)
  })

  test('failed attempts (no recordAuthenticated) still count globally and still trip the penalty', () => {
    const limiter = createLoginRateLimiter({ globalMaxFailures: 3, windowMs: 60_000 })

    limiter.recordFailure('a')
    limiter.recordFailure('b')
    limiter.recordFailure('c')

    expect(limiter.penaltyMs('anyone')).toBeGreaterThan(0)
  })

  test('a success never forgives a DIFFERENT key\'s still-unresolved failure, even interleaved', () => {
    // The scenario the naive "pop the newest global timestamp" fix gets
    // wrong: key A's failure is recorded first (still in flight — nobody has
    // authenticated for it yet), then key B's own failure/success pair
    // completes AFTER it. Forgiving B's own entry must never remove A's.
    const limiter = createLoginRateLimiter({ globalMaxFailures: 1, windowMs: 60_000 })

    limiter.recordFailure('A') // A's own provisional entry — still unresolved
    limiter.recordFailure('B')
    limiter.recordAuthenticated('B') // B turned out fine; forgive ONLY B's entry

    // A's failure is still counted: the global window must still be tripped.
    expect(limiter.penaltyMs('anyone')).toBeGreaterThan(0)
  })

  test('recordAuthenticated with no matching prior recordFailure for that key is a no-op on the global window', () => {
    const limiter = createLoginRateLimiter({ globalMaxFailures: 1, windowMs: 60_000 })
    limiter.recordFailure('a')

    limiter.recordAuthenticated('never-failed')

    // Nothing was removed on `a`'s behalf by an unrelated key's "success".
    expect(limiter.penaltyMs('anyone')).toBeGreaterThan(0)
  })

  test('interleaved concurrent attempts on the SAME key keep the global count exact', () => {
    const limiter = createLoginRateLimiter({ globalMaxFailures: 100, windowMs: 60_000 })

    // Two concurrent requests for the same key: both record a provisional
    // failure before either resolves, then both turn out authenticated.
    limiter.recordFailure('k')
    limiter.recordFailure('k')
    limiter.recordAuthenticated('k')
    limiter.recordAuthenticated('k')

    // Both provisional entries were forgiven — exactly two removed for two added.
    expect(limiter.penaltyMs('anyone')).toBe(0)
  })
})
