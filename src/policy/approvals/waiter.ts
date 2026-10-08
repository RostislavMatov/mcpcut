import { APPROVAL_POLL_INTERVAL_MS } from '../constants.js'
import type { ApprovalResolution } from './queue.js'

/**
 * Polls a resolved-file queue for an approval decision. Deliberately
 * polling-only (see `APPROVAL_POLL_INTERVAL_MS`'s doc comment): no
 * `fs.watch`, so behavior is identical across platforms and the only timing
 * knobs are the poll interval and an injectable clock.
 */

/**
 * `withdrawn` (decision M36): the request was closed because its agent stopped
 * waiting — the gate withdrew it (its signal), or the heartbeat sweep did. It
 * is not a denial: nobody decided against the call, and nothing is sent.
 */
export type WaitOutcome = 'approved' | 'denied' | 'timeout' | 'withdrawn'

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
 * outcome: a `timeout` (no decision was made at all), a `withdrawn` one (the
 * agent left, M36) and an `expired` resolution (a capped wait and the lazy
 * sweep record a resolution no operator made). `expired` is excluded even when the stored record does
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
   * a human recorded one) or `'withdrawn'` once `queue.readResolution`
   * reports a resolution; with `'timeout'` once `timeoutMs` elapses (per the
   * injected clock) with none — an `undefined` timeout has no deadline at all
   * (M36: the call is held while its agent holds); and with `'withdrawn'` the
   * moment `signal` aborts. The promise settles exactly once: whatever lands
   * after a settlement stops polling before it can be observed, so it can
   * never flip an already-settled result.
   */
  wait(
    queue: ResolutionSource,
    approvalId: string,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<WaitResult>
  /**
   * Immediately settles every in-flight `wait()` call with `'timeout'` and
   * clears their timers. Used at session teardown, after the gate withdrew
   * every call it holds, so no wait (and no timer)
   * outlives the session that started it.
   */
  cancelAll(): void
}

interface InFlightWait {
  settle(result: WaitResult): void
}

/** Settlement of a wait nobody answered; shared by the deadline and `cancelAll()`. */
const TIMED_OUT: WaitResult = Object.freeze({ outcome: 'timeout' as const })

/** Settlement of a wait whose request was withdrawn (the signal, or a stored `withdrawn`). */
const WITHDRAWN: WaitResult = Object.freeze({ outcome: 'withdrawn' as const })

/**
 * Maps a persisted resolution to a wait result. `expired` counts as `denied`:
 * fail closed. `withdrawn` is its own result and, like `expired`, names
 * nobody. See `WaitResult` for why an `expired` record's actor is deliberately
 * not carried over.
 */
function toWaitResult(resolution: ApprovalResolution): WaitResult {
  if (resolution.outcome === 'withdrawn') return WITHDRAWN
  const outcome: WaitOutcome = resolution.outcome === 'approved' ? 'approved' : 'denied'
  const isHumanResolution = resolution.outcome !== 'expired'
  return isHumanResolution && resolution.actor !== undefined
    ? { outcome, actor: resolution.actor }
    : { outcome }
}

/** One wait's polling loop: reads until a resolution, the deadline, or `stop()`. */
interface Poller {
  readonly start: () => void
  /** Settles the wait with `result` unless it already settled; idempotent. */
  readonly stop: (result: WaitResult) => void
}

interface PollerDeps {
  readonly read: () => Promise<ApprovalResolution | null>
  readonly deadlineMs: number
  readonly pollIntervalMs: number
  readonly clock: () => number
  /** Called exactly once, with the result the wait settled to. */
  readonly onSettle: (result: WaitResult) => void
}

function createPoller(deps: PollerDeps): Poller {
  let settled = false
  let timer: NodeJS.Timeout | undefined

  function stop(result: WaitResult): void {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    deps.onSettle(result)
  }

  function scheduleNext(): void {
    const remainingMs = deps.deadlineMs - deps.clock()
    const delayMs = Math.max(0, Math.min(deps.pollIntervalMs, remainingMs))
    timer = setTimeout(() => {
      void poll()
    }, delayMs)
    timer.unref?.()
  }

  async function poll(): Promise<void> {
    if (settled) return
    let resolution: ApprovalResolution | null
    try {
      resolution = await deps.read()
    } catch {
      resolution = null
    }
    // cancelAll(), the signal or a prior tick may have settled this wait while the read was in flight.
    if (settled) return
    if (resolution !== null) return stop(toWaitResult(resolution))
    if (deps.clock() >= deps.deadlineMs) return stop(TIMED_OUT)
    scheduleNext()
  }

  return { start: () => void poll(), stop }
}

export function createApprovalWaiter(opts: ApprovalWaiterOptions = {}): ApprovalWaiter {
  const pollIntervalMs = opts.pollIntervalMs ?? APPROVAL_POLL_INTERVAL_MS
  const clock = opts.clock ?? Date.now
  const inFlight = new Set<InFlightWait>()

  function wait(
    queue: ResolutionSource,
    approvalId: string,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<WaitResult> {
    return new Promise<WaitResult>((resolve) => {
      if (signal?.aborted === true) {
        resolve(WITHDRAWN)
        return
      }
      const onAbort = (): void => poller.stop(WITHDRAWN)
      const entry: InFlightWait = { settle: (result) => poller.stop(result) }
      const poller = createPoller({
        read: () => queue.readResolution(approvalId),
        deadlineMs: timeoutMs === undefined ? Number.POSITIVE_INFINITY : clock() + timeoutMs,
        pollIntervalMs,
        clock,
        onSettle: (result) => {
          inFlight.delete(entry)
          signal?.removeEventListener('abort', onAbort)
          resolve(result)
        },
      })
      inFlight.add(entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      poller.start()
    })
  }

  function cancelAll(): void {
    for (const entry of Array.from(inFlight)) {
      entry.settle(TIMED_OUT)
    }
  }

  return { wait, cancelAll }
}
