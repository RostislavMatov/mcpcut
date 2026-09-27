/**
 * Request budget of the agent front (plan `hosted-path-and-ops`, P7): how many
 * HTTP requests one install's agents may send, for a hosted (tenant) install.
 * Two limits, both answered from the same `take(now)`:
 *
 *  - **per second** — a token bucket refilled at `perSecond` tokens a second,
 *    holding at most `BURST_FACTOR × perSecond`. A client that was quiet may
 *    burst to twice its rate once; a steady client gets exactly its rate.
 *  - **per day** — a SLIDING 24-hour window counted in clock-hour buckets:
 *    the requests admitted in the current hour and the 23 before it may not
 *    exceed `perDay`. Chosen over a fixed UTC day, which is simpler but lets
 *    a client spend two days' worth around midnight; hour buckets bound that
 *    edge to two windows at least 23 hours apart, at the cost of at most 24
 *    counters.
 *
 * Only time and numbers: the module knows nothing about what a request
 * carries (CLAUDE.md layering invariant — no JSON-RPC here). The clock is the
 * caller's argument, never read, so every edge is a plain unit test.
 *
 * A REFUSED request costs nothing: it neither spends a token nor counts toward
 * the day, so a client hammering through a refusal does not push its own
 * recovery further out. The day limit is checked first, so a day refusal
 * never touches the bucket either.
 *
 * The counters live in memory; a restart starts both limits afresh (plan P7,
 * accepted).
 */

/** The bucket holds this many seconds' worth of tokens at most. */
export const BURST_FACTOR = 2

export const HOUR_MS = 3_600_000

/** Hours in the sliding day window. */
const DAY_WINDOW_HOURS = 24

export const DAY_WINDOW_MS = DAY_WINDOW_HOURS * HOUR_MS

const MS_PER_SECOND = 1_000

/** Retry-After is whole seconds (RFC 9110 §10.2.3), and a refusal never says "retry now". */
const MIN_RETRY_AFTER_SECONDS = 1

export interface RequestBudgetLimits {
  /** Sustained requests per second; the bucket bursts to `BURST_FACTOR` times this. */
  readonly perSecond: number
  /** Requests in any sliding 24-hour window (clock-hour granularity). */
  readonly perDay: number
}

export type BudgetDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryAfterSeconds: number }

export interface RequestBudget {
  /** Spends one request at `nowMs` (epoch milliseconds), or says how long to wait. */
  take(nowMs: number): BudgetDecision
}

interface HourCount {
  readonly hour: number
  readonly count: number
}

interface BudgetState {
  readonly tokens: number
  readonly refilledAt: number
  readonly hours: readonly HourCount[]
}

const ADMITTED: BudgetDecision = Object.freeze({ ok: true })

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`request budget: ${name} must be a positive integer, got ${String(value)}`)
  }
}

function refusal(waitMs: number): BudgetDecision {
  const seconds = Math.ceil(waitMs / MS_PER_SECOND)
  return Object.freeze({ ok: false, retryAfterSeconds: Math.max(MIN_RETRY_AFTER_SECONDS, seconds) })
}

/** Tokens after refilling up to `nowMs`. A clock that stepped back refills nothing. */
function refill(state: BudgetState, nowMs: number, limits: RequestBudgetLimits): BudgetState {
  const elapsedMs = Math.max(0, nowMs - state.refilledAt)
  const burst = BURST_FACTOR * limits.perSecond
  const tokens = Math.min(burst, state.tokens + (elapsedMs * limits.perSecond) / MS_PER_SECOND)
  return { ...state, tokens, refilledAt: Math.max(state.refilledAt, nowMs) }
}

/** Hour buckets still inside the window that ends in `nowMs`'s hour. */
function liveHours(hours: readonly HourCount[], nowMs: number): readonly HourCount[] {
  const currentHour = Math.floor(nowMs / HOUR_MS)
  return hours.filter((entry) => entry.hour > currentHour - DAY_WINDOW_HOURS)
}

/** When the oldest counted hour leaves the window, as a wait from `nowMs`. */
function dayWaitMs(hours: readonly HourCount[], nowMs: number): number {
  const oldest = Math.min(...hours.map((entry) => entry.hour))
  return (oldest + DAY_WINDOW_HOURS) * HOUR_MS - nowMs
}

function countedIn(hours: readonly HourCount[], nowMs: number): readonly HourCount[] {
  const hour = Math.floor(nowMs / HOUR_MS)
  const existing = hours.find((entry) => entry.hour === hour)
  if (existing === undefined) {
    return [...hours, { hour, count: 1 }]
  }
  return hours.map((entry) => (entry.hour === hour ? { hour, count: entry.count + 1 } : entry))
}

interface Step {
  readonly state: BudgetState
  readonly decision: BudgetDecision
}

/** One `take`, as a pure transition: the next state and the answer. */
function step(state: BudgetState, nowMs: number, limits: RequestBudgetLimits): Step {
  const hours = liveHours(state.hours, nowMs)
  const used = hours.reduce((sum, entry) => sum + entry.count, 0)
  if (used >= limits.perDay) {
    return { state: { ...state, hours }, decision: refusal(dayWaitMs(hours, nowMs)) }
  }
  const refilled = refill({ ...state, hours }, nowMs, limits)
  if (refilled.tokens < 1) {
    const waitMs = ((1 - refilled.tokens) * MS_PER_SECOND) / limits.perSecond
    return { state: refilled, decision: refusal(waitMs) }
  }
  return {
    state: { ...refilled, tokens: refilled.tokens - 1, hours: countedIn(hours, nowMs) },
    decision: ADMITTED,
  }
}

/**
 * A budget with a full bucket and an empty day. Throws `RangeError` for a
 * limit that is not a positive integer — the config schema bounds both, so
 * reaching this is a wiring bug, and a budget that silently admitted
 * everything (or nothing) would be worse than a refused start.
 */
export function createRequestBudget(limits: RequestBudgetLimits): RequestBudget {
  assertPositiveInteger('perSecond', limits.perSecond)
  assertPositiveInteger('perDay', limits.perDay)
  const frozen: RequestBudgetLimits = Object.freeze({ ...limits })
  let state: BudgetState = {
    tokens: BURST_FACTOR * frozen.perSecond,
    refilledAt: Number.NEGATIVE_INFINITY,
    hours: [],
  }
  return Object.freeze({
    take(nowMs: number): BudgetDecision {
      const next = step(state, nowMs, frozen)
      state = next.state
      return next.decision
    },
  })
}
