import { createDeferred, type Deferred, type ResponseCorrelation } from './session-support.js'

/**
 * The waiting room of a correlating session (ADR-0015 phase 3, plan decision
 * P1): requests filed under the key the injected hooks give them, and the
 * answers that settle them. Split out of `session-exchange.ts` for the
 * <400-line file rule when phase B of decision M36 gave the exchange its POST
 * streams; as semantics-free as its parent — a key is only ever compared.
 */

/** What registering one request in the waiting room produced. */
export type RegisterOutcome =
  /** Nothing to wait for: the body is owed no answer (a notification, or a key the hook refused). */
  | { readonly kind: 'unkeyed' }
  /** A key already in flight; the CLIENT reused an id. */
  | { readonly kind: 'duplicate' }
  /** The room is full. */
  | { readonly kind: 'at-capacity' }
  /** Registered; await `pending`, and call `unregister` if the wait fails. */
  | {
      readonly kind: 'waiting'
      /** The key the request is filed under (also what marks it abandoned). */
      readonly key: string
      readonly pending: Deferred<Buffer>
      unregister(): void
    }

/**
 * The key a hook would file `bytes` under, or `null` when it correlates
 * nothing. A hook handed garbage may throw — that is read as "owed no answer",
 * the same fail-closed reading `expectsResponse` gets, because a malformed body
 * must not take the request handler down with it.
 */
export function correlationKeyOf(
  correlate: ResponseCorrelation,
  which: 'keyOfRequest' | 'keyOfResponse',
  bytes: Buffer,
  onError: (error: unknown) => void,
): string | null {
  try {
    return correlate[which](bytes)
  } catch (error: unknown) {
    onError(error)
    return null
  }
}

/**
 * Files one outgoing request. A duplicate key is the CLIENT's error rather
 * than the session being busy: two live requests under one id is "one outcome
 * per id" broken, and the manager will not quietly pick between them. A full
 * room fails closed rather than evicting, for the same reason the pool's
 * correlator does — a forgotten key is a reply with nowhere to go.
 */
export function registerWaiter(
  waiting: Map<string, Deferred<Buffer>>,
  correlate: ResponseCorrelation,
  body: Buffer,
  maxInFlight: number,
  onError: (error: unknown) => void,
): RegisterOutcome {
  const key = correlationKeyOf(correlate, 'keyOfRequest', body, onError)
  if (key === null) {
    return { kind: 'unkeyed' }
  }
  if (waiting.has(key)) {
    return { kind: 'duplicate' }
  }
  if (waiting.size >= maxInFlight) {
    return { kind: 'at-capacity' }
  }

  const pending = createDeferred<Buffer>()
  waiting.set(key, pending)
  return {
    kind: 'waiting',
    key,
    pending,
    unregister: (): void => {
      // Guarded on identity: a later request under the same key must not be
      // unregistered by an earlier one's failure.
      if (waiting.get(key) === pending) {
        waiting.delete(key)
      }
    },
  }
}

/** The waiter `payload` answers, removed from the room; `null` when it answers none. */
export function takeWaiter(
  waiting: Map<string, Deferred<Buffer>>,
  correlate: ResponseCorrelation,
  payload: Buffer,
  onError: (error: unknown) => void,
): Deferred<Buffer> | null {
  if (waiting.size === 0) {
    return null
  }
  const key = correlationKeyOf(correlate, 'keyOfResponse', payload, onError)
  if (key === null) {
    return null
  }
  const waiter = waiting.get(key)
  if (waiter === undefined) {
    return null
  }
  waiting.delete(key)
  return waiter
}

/** Ends every wait with `error` and empties the room. */
export function rejectAllWaiting(
  waiting: Map<string, Deferred<Buffer>>,
  error: () => Error,
): void {
  for (const waiter of [...waiting.values()]) {
    waiter.reject(error())
  }
  waiting.clear()
}
