import { describe, expect, test } from 'vitest'
import { createSubscriptionTimer } from '../../src/tui/runtime-timer.js'

/**
 * The console's one subscription timer (mcpcut phase 5, task 7).
 *
 * Real timers on purpose, and short ones: the property under test is about
 * WHEN a pending timer is kept and when it is thrown away, and a fake clock
 * would only re-assert the calls the implementation makes rather than the
 * behaviour the runtime depends on. The reconcile is called after EVERY step
 * of the loop — that is, after every keystroke — so the rule that a pending
 * timer survives a reconcile with the same subscription is what keeps a busy
 * typist from postponing the Approvals poll for ever.
 */

/** Long enough to survive a slow CI worker, short enough to keep the file quick. */
const TICK_MS = 10

/**
 * A second, much slower subscription — what a tab with its own interval hands
 * in. Long enough that "the old deadline fired" and "the new one did" are far
 * apart on a busy worker.
 */
const SLOW_TICK_MS = 300

/** When a keystroke reconciles again, on the way to `SLOW_TICK_MS`. */
const TYPED_AFTER_MS = 150

/**
 * A kept deadline fires at `SLOW_TICK_MS` (300 ms); a re-armed one no earlier
 * than 150 + 300. The bound sits nearer the re-arm than the keep — 120 ms of
 * slack rather than 75 — because a loaded CI worker delays the timer callback,
 * and a delay is the only way this can fail spuriously: it is still 30 ms
 * below the earliest a re-armed timer could fire, which is what the test is
 * actually distinguishing.
 */
const KEPT_DEADLINE_BOUND_MS = 420

/** How long a tick that is expected is waited for, and how long an absent one is watched. */
const WAIT_TIMEOUT_MS = 1_000
const ABSENCE_WINDOW_MS = 60

interface Ticks {
  readonly count: () => number
  readonly onTick: () => void
}

function countingTicks(): Ticks {
  let count = 0
  return {
    count: () => count,
    onTick: () => {
      count += 1
    },
  }
}

async function waitForTicks(ticks: Ticks, wanted: number): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (ticks.count() < wanted) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${wanted} tick(s); saw ${ticks.count()}`)
    }
    await sleep(1)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('createSubscriptionTimer', () => {
  test('a subscription arms the timer, and it fires exactly once', async () => {
    const ticks = countingTicks()
    const timer = createSubscriptionTimer(ticks.onTick)

    timer.reconcile(TICK_MS)
    await waitForTicks(ticks, 1)

    // The timer is a one-shot: re-arming is the loop's job, after the answer.
    // ABSENCE assertion — a fixed window is the only way to watch for a second
    // tick that must never come.
    await sleep(ABSENCE_WINDOW_MS)
    expect(ticks.count()).toBe(1)
    timer.clear()
  })

  test('a second reconcile with the SAME delay does not postpone the tick', async () => {
    const ticks = countingTicks()
    const timer = createSubscriptionTimer(ticks.onTick)
    const armedAt = Date.now()

    timer.reconcile(SLOW_TICK_MS)
    // Every step of the loop reconciles again, and a step is every keystroke.
    // A timer re-armed here would push its deadline out by however long the
    // operator has been typing, and the queue would go quiet exactly while
    // somebody is working in it.
    await sleep(TYPED_AFTER_MS)
    timer.reconcile(SLOW_TICK_MS)
    timer.reconcile(SLOW_TICK_MS)

    await waitForTicks(ticks, 1)
    expect(Date.now() - armedAt).toBeLessThan(KEPT_DEADLINE_BOUND_MS)
    timer.clear()
  })

  test('a reconcile with a DIFFERENT delay re-arms: the new subscription owns the clock', async () => {
    const ticks = countingTicks()
    const timer = createSubscriptionTimer(ticks.onTick)

    timer.reconcile(TICK_MS)
    // A second self-reading tab declares its own, slower interval. Keeping the
    // pending timer would fire it at the OTHER tab's rate.
    timer.reconcile(SLOW_TICK_MS)

    // ABSENCE assertion: the abandoned deadline has long passed by now.
    await sleep(ABSENCE_WINDOW_MS)
    expect(ticks.count()).toBe(0)
    // …and the delay that was asked for still arrives.
    await waitForTicks(ticks, 1)
    timer.clear()
  })

  test('a shorter delay is adopted at once rather than waiting out the longer one', async () => {
    const ticks = countingTicks()
    const timer = createSubscriptionTimer(ticks.onTick)
    const armedAt = Date.now()

    timer.reconcile(SLOW_TICK_MS)
    timer.reconcile(TICK_MS)

    await waitForTicks(ticks, 1)
    expect(Date.now() - armedAt).toBeLessThan(SLOW_TICK_MS)
    timer.clear()
  })

  test('no subscription means no tick', async () => {
    const ticks = countingTicks()
    const timer = createSubscriptionTimer(ticks.onTick)

    timer.reconcile(undefined)

    // ABSENCE assertion: nothing was armed, so there is no event to wait for.
    await sleep(ABSENCE_WINDOW_MS)
    expect(ticks.count()).toBe(0)
  })

  test('a subscription that goes away takes the pending timer with it', async () => {
    const ticks = countingTicks()
    const timer = createSubscriptionTimer(ticks.onTick)

    timer.reconcile(TICK_MS)
    timer.reconcile(undefined)

    // ABSENCE assertion: the window is six times the delay that was cancelled.
    await sleep(ABSENCE_WINDOW_MS)
    expect(ticks.count()).toBe(0)
  })

  test('clear stops a pending timer, which is what the console leaving does', async () => {
    const ticks = countingTicks()
    const timer = createSubscriptionTimer(ticks.onTick)

    timer.reconcile(TICK_MS)
    timer.clear()

    // ABSENCE assertion: a tick after `finish` would step a settled console.
    await sleep(ABSENCE_WINDOW_MS)
    expect(ticks.count()).toBe(0)
  })

  test('clearing a timer that was never armed is not an error', () => {
    const ticks = countingTicks()
    const timer = createSubscriptionTimer(ticks.onTick)

    expect(() => {
      timer.clear()
      timer.clear()
    }).not.toThrow()
    expect(ticks.count()).toBe(0)
  })

  test('after a tick the next reconcile arms again', async () => {
    const ticks = countingTicks()
    const timer = createSubscriptionTimer(ticks.onTick)

    timer.reconcile(TICK_MS)
    await waitForTicks(ticks, 1)
    timer.reconcile(TICK_MS)

    await waitForTicks(ticks, 2)
    timer.clear()
  })
})
