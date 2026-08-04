import { APPROVAL_POLL_INTERVAL_MS } from '../constants.js'
import type { ApprovalResolution } from './queue.js'

/**
 * Polls a resolved-file queue for an approval decision. Deliberately
 * polling-only (see `APPROVAL_POLL_INTERVAL_MS`'s doc comment): no
 * `fs.watch`, so behavior is identical across platforms and the only timing
 * knobs are the poll interval and an injectable clock.
 */

export type WaitOutcome = 'approved' | 'denied' | 'timeout'

/** The subset of `ApprovalQueue` a waiter needs, so tests can pass a minimal fake. */
export interface ResolutionSource {
  readResolution(approvalId: string): Promise<ApprovalResolution | null>
}

export interface ApprovalWaiterOptions {
  /** Milliseconds between polls. Defaults to `APPROVAL_POLL_INTERVAL_MS`. */
  readonly pollIntervalMs?: number
  /** Injectable clock for deterministic deadline math. Defaults to `Date.now`. */
  readonly clock?: () => number
}

export interface ApprovalWaiter {
  /**
   * Resolves with `'approved'` / `'denied'` once `queue.readResolution`
   * reports a decision, or `'timeout'` once `timeoutMs` elapses (per the
   * injected clock) with no decision. The promise settles exactly once: a
   * resolution that lands after the deadline has already fired the
   * `'timeout'` settlement stops polling before it can be observed, so it
   * can never flip an already-settled result.
   */
  wait(queue: ResolutionSource, approvalId: string, timeoutMs: number): Promise<WaitOutcome>
  /**
   * Immediately settles every in-flight `wait()` call with `'timeout'` and
   * clears their timers. Used at session teardown so no wait (and no timer)
   * outlives the session that started it.
   */
  cancelAll(): void
}

interface InFlightWait {
  settle(outcome: WaitOutcome): void
}

/** Maps a persisted resolution to a wait outcome. `'expired'` (session teardown) counts as `'denied'`: fail closed. */
function toWaitOutcome(resolution: ApprovalResolution): WaitOutcome {
  return resolution.outcome === 'approved' ? 'approved' : 'denied'
}

export function createApprovalWaiter(opts: ApprovalWaiterOptions = {}): ApprovalWaiter {
  const pollIntervalMs = opts.pollIntervalMs ?? APPROVAL_POLL_INTERVAL_MS
  const clock = opts.clock ?? Date.now
  const inFlight = new Set<InFlightWait>()

  function wait(queue: ResolutionSource, approvalId: string, timeoutMs: number): Promise<WaitOutcome> {
    return new Promise<WaitOutcome>((resolve) => {
      const deadlineMs = clock() + timeoutMs
      let settled = false
      let timer: NodeJS.Timeout | undefined

      const entry: InFlightWait = { settle: finish }
      inFlight.add(entry)

      function finish(outcome: WaitOutcome): void {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        inFlight.delete(entry)
        resolve(outcome)
      }

      function scheduleNext(): void {
        const remainingMs = deadlineMs - clock()
        const delayMs = Math.max(0, Math.min(pollIntervalMs, remainingMs))
        timer = setTimeout(() => {
          void poll()
        }, delayMs)
        timer.unref?.()
      }

      async function poll(): Promise<void> {
        if (settled) return

        let resolution: ApprovalResolution | null
        try {
          resolution = await queue.readResolution(approvalId)
        } catch {
          resolution = null
        }
        // cancelAll()/a prior tick may have settled this wait while the read was in flight.
        if (settled) return

        if (resolution !== null) {
          finish(toWaitOutcome(resolution))
          return
        }
        if (clock() >= deadlineMs) {
          finish('timeout')
          return
        }
        scheduleNext()
      }

      void poll()
    })
  }

  function cancelAll(): void {
    for (const entry of Array.from(inFlight)) {
      entry.settle('timeout')
    }
  }

  return { wait, cancelAll }
}
