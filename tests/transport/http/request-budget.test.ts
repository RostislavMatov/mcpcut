import { describe, expect, test } from 'vitest'
import {
  BURST_FACTOR,
  createRequestBudget,
  DAY_WINDOW_MS,
  HOUR_MS,
  type RequestBudget,
} from '../../../src/transport/http/request-budget.js'

/**
 * The agent front's request budget (plan `hosted-path-and-ops`, P7): a token
 * bucket of N per second with a burst of 2N, plus a sliding 24-hour window
 * counted in clock-hour buckets. Pure time-and-numbers — the clock is always
 * the argument, never read.
 */

/** 2026-09-27T10:00:00Z — on an hour boundary, so hour arithmetic reads plainly. */
const T0 = Date.UTC(2026, 8, 27, 10, 0, 0)

function takeMany(budget: RequestBudget, count: number, now: number): number {
  let admitted = 0
  for (let i = 0; i < count; i += 1) {
    if (budget.take(now).ok) admitted += 1
  }
  return admitted
}

describe('createRequestBudget: per-second token bucket', () => {
  test('a burst admits exactly 2N; request 2N+1 is refused with Retry-After 1', () => {
    const budget = createRequestBudget({ perSecond: 10, perDay: 10_000 })

    expect(takeMany(budget, 20, T0)).toBe(20)
    expect(budget.take(T0)).toEqual({ ok: false, retryAfterSeconds: 1 })
  })

  test('the bucket refills at N per second: one second later N more are admitted, not 2N', () => {
    const budget = createRequestBudget({ perSecond: 10, perDay: 10_000 })
    takeMany(budget, 20, T0)

    expect(takeMany(budget, 11, T0 + 1_000)).toBe(10)
  })

  test('refill never exceeds the burst: a long pause still admits only 2N at once', () => {
    const budget = createRequestBudget({ perSecond: 10, perDay: 10_000 })
    takeMany(budget, 20, T0)

    expect(takeMany(budget, 25, T0 + 60_000)).toBe(BURST_FACTOR * 10)
  })

  test('Retry-After is whole seconds, rounded up, never below 1', () => {
    const budget = createRequestBudget({ perSecond: 1, perDay: 10_000 })
    takeMany(budget, 2, T0)

    // 0.2 s after an empty bucket at 1/s: 0.8 s still missing → 1.
    expect(budget.take(T0 + 200)).toEqual({ ok: false, retryAfterSeconds: 1 })
  })

  test('a refused request costs nothing: hammering does not push the recovery further out', () => {
    const budget = createRequestBudget({ perSecond: 10, perDay: 10_000 })
    takeMany(budget, 20, T0)
    takeMany(budget, 500, T0 + 50)

    expect(budget.take(T0 + 100).ok).toBe(true)
  })

  test('a clock that steps backwards refills nothing and throws nothing', () => {
    const budget = createRequestBudget({ perSecond: 10, perDay: 10_000 })
    takeMany(budget, 20, T0)

    expect(budget.take(T0 - 5_000).ok).toBe(false)
  })
})

describe('createRequestBudget: sliding 24-hour window in clock-hour buckets', () => {
  test('request perDay+1 in the window is refused even with tokens in the bucket', () => {
    const budget = createRequestBudget({ perSecond: 1_000, perDay: 30 })

    expect(takeMany(budget, 30, T0)).toBe(30)
    expect(budget.take(T0 + 10_000).ok).toBe(false)
  })

  test('Retry-After names the moment the oldest counted hour leaves the window', () => {
    const budget = createRequestBudget({ perSecond: 1_000, perDay: 3 })
    budget.take(T0 + 30 * 60_000) // counted in the 10:00 hour
    budget.take(T0 + 3 * HOUR_MS) // 13:00
    budget.take(T0 + 5 * HOUR_MS) // 15:00

    const now = T0 + 6 * HOUR_MS // 16:00: the 10:00 hour leaves at 10:00 tomorrow
    expect(budget.take(now)).toEqual({ ok: false, retryAfterSeconds: 18 * 3_600 })
  })

  test('once the oldest hour slides out, its requests are available again', () => {
    const budget = createRequestBudget({ perSecond: 1_000, perDay: 3 })
    takeMany(budget, 3, T0 + 59 * 60_000)

    expect(budget.take(T0 + DAY_WINDOW_MS - 1).ok).toBe(false)
    expect(takeMany(budget, 4, T0 + DAY_WINDOW_MS)).toBe(3)
  })

  test('a request refused by the bucket does not count toward the day', () => {
    const budget = createRequestBudget({ perSecond: 1, perDay: 3 })
    takeMany(budget, 2, T0) // burst of 2 spent; day at 2 of 3
    takeMany(budget, 10, T0) // all refused by the bucket

    expect(budget.take(T0 + 1_000).ok).toBe(true) // day at 3 of 3, not 13
    expect(budget.take(T0 + 5_000).ok).toBe(false)
  })
})

describe('createRequestBudget: limits are validated at the boundary', () => {
  test.each([
    ['zero per second', { perSecond: 0, perDay: 10 }],
    ['fractional per second', { perSecond: 1.5, perDay: 10 }],
    ['negative per day', { perSecond: 1, perDay: -1 }],
    ['NaN per day', { perSecond: 1, perDay: Number.NaN }],
  ])('%s → RangeError', (_name, limits) => {
    expect(() => createRequestBudget(limits)).toThrow(RangeError)
  })
})
