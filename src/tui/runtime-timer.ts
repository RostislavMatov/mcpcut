/**
 * The console's ONE subscription timer (mcpcut phase 5, task 7).
 *
 * The runtime asks `subscriptionOf(model)` after every step and hands the
 * answer here. That answer is a pure function of the model, so this file has
 * no idea what is being polled, how often, or why it stopped — it holds the
 * single piece of mutable state the answer needs to become a clock.
 *
 * The rule worth reading the file for is what a reconcile does to a timer that
 * is already pending: nothing, AS LONG AS the delay is the one it was armed
 * with. A step happens on every keystroke, and a timer re-armed on each one
 * would let an operator who is typing postpone the Approvals poll indefinitely
 * — the queue would go quiet exactly while somebody is working in it. So a
 * pending timer keeps its deadline while the same subscription stands, and is
 * dropped the moment it is gone (a run started, a form opened, the tab left).
 * The interval then counts from the ANSWER of the poll rather than from the
 * tick, because `polling` takes the subscription away until `poll-result`
 * folds in (plan P1).
 *
 * A CHANGED delay is a different subscription, not the same one, so it re-arms:
 * the answer is a pure function of the model, and the model can move from one
 * self-reading tab to another with an interval of its own. Keeping the pending
 * timer there would fire the new tab's poll at the old tab's rate — the wrong
 * clock, in both directions.
 */

/** The runtime's handle on the timer: reconcile it with the model, or drop it. */
export interface SubscriptionTimer {
  /**
   * Arms a timer for `delayMs`, keeps a pending one armed with that SAME
   * delay, re-arms when the delay changed, or clears when there is no
   * subscription at all.
   */
  reconcile(delayMs: number | undefined): void
  /** Drops the pending timer; the console leaving calls this before it settles. */
  clear(): void
}

export function createSubscriptionTimer(onTick: () => void): SubscriptionTimer {
  let timer: NodeJS.Timeout | undefined
  /** The delay the pending timer was armed with; how a kept one is told from a stale one. */
  let armedDelayMs: number | undefined

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    armedDelayMs = undefined
  }

  return {
    reconcile: (delayMs: number | undefined): void => {
      if (delayMs === undefined) {
        clear()
        return
      }
      if (timer !== undefined && armedDelayMs === delayMs) return
      clear()

      armedDelayMs = delayMs
      timer = setTimeout(() => {
        // Cleared BEFORE the callback: `onTick` steps the loop, which
        // reconciles again, and it must find no timer pending or the next
        // poll would never be armed.
        timer = undefined
        armedDelayMs = undefined
        onTick()
      }, delayMs)
      // The console is the process's foreground; a poll that is merely due
      // must never be the reason Node stays alive (nor a vitest worker).
      timer.unref()
    },
    clear,
  }
}
