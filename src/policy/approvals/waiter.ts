import { APPROVAL_POLL_INTERVAL_MS } from '../constants.js'
import type { ApprovalResolution } from './queue.js'

/**
 * Polls a resolved-file queue for an approval decision. Deliberately
 * polling-only (see `APPROVAL_POLL_INTERVAL_MS`'s doc comment): no
 * `fs.watch`, so behavior is identical across platforms and the only timing
 * knobs are the poll interval and an injectable clock.
 */

export type WaitOutcome = 'approved' | 'denied' | 'timeout'

/**
 * What one wait settled to, and WHO settled it when a human did (M5 wave 2).
 *
 * The waiter is the only component that ever holds the `ApprovalResolution`
 * an operator wrote: it read the record, mapped it to an outcome and dropped
 * everything else. That is why the gate's terminal record could say "this
 * destructive call was approved" with no answer to "by whom" — the answer
 * existed and was discarded one layer below. Surfacing it here rather than
 * re-reading the resolution in the gate keeps a single read of an immutable
 * record: no second round trip on the hot path, and no way for the record
 * the gate attributes to differ from the one the wait settled on.
 *
 * `actor` is ABSENT — not null, not empty — whenever no human determined the
 * outcome: a `timeout` (no decision was made at all) and an `expired`
 * resolution (session teardown and the lazy sweep record a resolution no
 * operator made). `expired` is excluded even when the stored record does
 * carry an actor: `resolve()` downgrades a stale `approved` to `expired`
 * while preserving that operator's name for the audit trail, and since the
 * waiter reports every non-`approved` resolution as a denial, attributing it
 * would produce a record reading "<operator> denied this call" about
 * somebody who approved it. An absent actor loses a detail; a wrong one is a
 * false statement in signed evidence.
 */
export interface WaitResult {
  readonly outcome: WaitOutcome
  readonly actor?: string
}

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
   * Resolves with `'approved'` / `'denied'` (plus the resolving `actor`, when
   * a human recorded one) once `queue.readResolution` reports a decision, or
   * `'timeout'` once `timeoutMs` elapses (per the injected clock) with no
   * decision. The promise settles exactly once: a
   * resolution that lands after the deadline has already fired the
   * `'timeout'` settlement stops polling before it can be observed, so it
   * can never flip an already-settled result.
   */
  wait(queue: ResolutionSource, approvalId: string, timeoutMs: number): Promise<WaitResult>
  /**
   * Immediately settles every in-flight `wait()` call with `'timeout'` and
   * clears their timers. Used at session teardown so no wait (and no timer)
   * outlives the session that started it.
   */
  cancelAll(): void
}

interface InFlightWait {
  settle(result: WaitResult): void
}

/** Settlement of a wait nobody answered; shared by the deadline and `cancelAll()`. */
const TIMED_OUT: WaitResult = Object.freeze({ outcome: 'timeout' as const })

/**
 * Maps a persisted resolution to a wait result. `'expired'` (session teardown)
 * counts as `'denied'`: fail closed. See `WaitResult` for why an `'expired'`
 * record's actor is deliberately not carried over.
 */
function toWaitResult(resolution: ApprovalResolution): WaitResult {
  const outcome: WaitOutcome = resolution.outcome === 'approved' ? 'approved' : 'denied'
  const isHumanResolution = resolution.outcome !== 'expired'
  return isHumanResolution && resolution.actor !== undefined
    ? { outcome, actor: resolution.actor }
    : { outcome }
}

export function createApprovalWaiter(opts: ApprovalWaiterOptions = {}): ApprovalWaiter {
  const pollIntervalMs = opts.pollIntervalMs ?? APPROVAL_POLL_INTERVAL_MS
  const clock = opts.clock ?? Date.now
  const inFlight = new Set<InFlightWait>()

  function wait(queue: ResolutionSource, approvalId: string, timeoutMs: number): Promise<WaitResult> {
    return new Promise<WaitResult>((resolve) => {
      const deadlineMs = clock() + timeoutMs
      let settled = false
      let timer: NodeJS.Timeout | undefined

      const entry: InFlightWait = { settle: finish }
      inFlight.add(entry)

      function finish(result: WaitResult): void {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        inFlight.delete(entry)
        resolve(result)
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
          finish(toWaitResult(resolution))
          return
        }
        if (clock() >= deadlineMs) {
          finish(TIMED_OUT)
          return
        }
        scheduleNext()
      }

      void poll()
    })
  }

  function cancelAll(): void {
    for (const entry of Array.from(inFlight)) {
      entry.settle(TIMED_OUT)
    }
  }

  return { wait, cancelAll }
}
