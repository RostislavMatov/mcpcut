import { clientMessage } from '../message.js'
import { HTTP_STATUS_ACCEPTED, HTTP_STATUS_NOT_FOUND } from './constants.js'
import {
  BODY_REQUEST_IN_FLIGHT,
  BODY_SESSION_NOT_FOUND,
  BODY_TOO_MANY_REQUESTS_IN_FLIGHT,
  HTTP_STATUS_CONFLICT,
  HTTP_STATUS_OK,
  HTTP_STATUS_TOO_MANY_REQUESTS,
} from './server-constants.js'
import {
  createDeferred,
  jsonPlan,
  SessionTornDownError,
  type BufferedMessages,
  type Deferred,
  type ExpectsResponse,
  type OpenedSession,
  type ResponseCorrelation,
  type ResponsePlan,
} from './session-support.js'

/**
 * How a POST is paired with its answer, and where an inbound payload goes.
 *
 * BOTH pairing rules live here, side by side, which is the point of the file:
 *
 *  - positional — "the answer is the next message this session emits", one
 *    POST at a time (every per-server address, unchanged since M3);
 *  - correlated — several POSTs at once, each waiting on the key its session's
 *    injected hooks produce (a pool address; ADR-0015 phase 3, plan decision
 *    P1).
 *
 * Keeping them in one module is what stops them drifting: the teardown → 404
 * mapping, the notification → 202 answer and the activity stamp are written
 * once and shared, so a change to one rule cannot silently leave the other
 * behind.
 *
 * Split out of `session.ts` for the file-size rule, the same way
 * `session-support.ts` and `session-stateless.ts` were, and it stays as
 * semantics-free as its parent: what a "key" means is entirely the injected
 * hooks' business, and this module only ever compares them.
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

// ---------------------------------------------------------------------------
// The two pairing rules
// ---------------------------------------------------------------------------

/**
 * The part of a live session these rules touch. Declared structurally rather
 * than importing `ActiveSession`: this module has no business with a session's
 * id, its (agent, server) pair or its SSE stream, and saying so in the type
 * keeps it that way.
 */
export interface PairedSession {
  readonly handle: OpenedSession
  readonly waiting: Map<string, Deferred<Buffer>>
  lastActivityMs: number
  inFlight: Deferred<Buffer> | null
  buffered: BufferedMessages
  /** Present and open when the agent holds a GET stream. */
  readonly stream: { isOpen(): boolean; send(payload: Buffer): void } | null
}

export interface ExchangeRulesDeps {
  readonly expectsResponse: ExpectsResponse
  /** Requests ONE correlating session may hold at once. */
  readonly maxCorrelatedInFlight: number
  readonly now: () => number
  /** Appends to the bounded server-message buffer (count and byte capped). */
  readonly buffer: (current: BufferedMessages, payload: Buffer) => BufferedMessages
  /** Reports a correlation-hook failure; it belongs to no one session. */
  readonly onHookError: (error: unknown) => void
}

export interface ExchangeRules {
  /** Answers one POST on an existing session, by whichever rule it declared. */
  post(session: PairedSession, body: Buffer): Promise<ResponsePlan>
  /** Writes `body` and answers with the session's next message (the handshake path). */
  exchange(session: PairedSession, body: Buffer): Promise<ResponsePlan>
  /** Delivers one server-origin payload: waiter > in-flight > stream > buffer. */
  deliver(session: PairedSession, payload: Buffer): void
}

export function createExchangeRules(deps: ExchangeRulesDeps): ExchangeRules {
  /**
   * Writes `body` into the session and awaits the answer it was registered
   * for, undoing the registration on any failure. Shared by both rules so the
   * teardown → 404 mapping cannot drift between them.
   */
  async function awaitAnswer(
    session: PairedSession,
    body: Buffer,
    pending: Deferred<Buffer>,
    unregister: () => void,
  ): Promise<ResponsePlan> {
    try {
      await session.handle.sink.write(clientMessage(body))
      const payload = await pending.promise
      return jsonPlan(HTTP_STATUS_OK, payload)
    } catch (error: unknown) {
      unregister()
      if (error instanceof SessionTornDownError) {
        return jsonPlan(HTTP_STATUS_NOT_FOUND, BODY_SESSION_NOT_FOUND)
      }
      throw error
    }
  }

  /** A body owed no answer: written and acknowledged, never registered. */
  async function acknowledge(session: PairedSession, body: Buffer): Promise<ResponsePlan> {
    await session.handle.sink.write(clientMessage(body))
    return Object.freeze({ status: HTTP_STATUS_ACCEPTED })
  }

  async function positional(session: PairedSession, body: Buffer): Promise<ResponsePlan> {
    if (!deps.expectsResponse(body)) {
      return acknowledge(session, body)
    }
    const pending = createDeferred<Buffer>()
    session.inFlight = pending
    return awaitAnswer(session, body, pending, () => {
      if (session.inFlight === pending) {
        session.inFlight = null
      }
    })
  }

  async function correlated(
    session: PairedSession,
    correlate: ResponseCorrelation,
    body: Buffer,
  ): Promise<ResponsePlan> {
    const registered = registerWaiter(
      session.waiting,
      correlate,
      body,
      deps.maxCorrelatedInFlight,
      deps.onHookError,
    )
    if (registered.kind === 'unkeyed') {
      return acknowledge(session, body)
    }
    if (registered.kind === 'duplicate') {
      return jsonPlan(HTTP_STATUS_CONFLICT, BODY_REQUEST_IN_FLIGHT)
    }
    if (registered.kind === 'at-capacity') {
      return jsonPlan(HTTP_STATUS_TOO_MANY_REQUESTS, BODY_TOO_MANY_REQUESTS_IN_FLIGHT)
    }
    return awaitAnswer(session, body, registered.pending, registered.unregister)
  }

  return Object.freeze({
    exchange: positional,

    post(session: PairedSession, body: Buffer): Promise<ResponsePlan> {
      const correlate = session.handle.correlate
      if (correlate !== undefined) {
        // Stamped on REGISTRATION, not only on the answer: a pool call held by
        // a human approval, on a session with no GET stream, would otherwise
        // be swept by the idle sweeper mid-wait.
        session.lastActivityMs = deps.now()
        return correlated(session, correlate, body)
      }
      if (session.inFlight !== null) {
        return Promise.resolve(jsonPlan(HTTP_STATUS_CONFLICT, BODY_REQUEST_IN_FLIGHT))
      }
      session.lastActivityMs = deps.now()
      return positional(session, body)
    },

    deliver(session: PairedSession, payload: Buffer): void {
      const correlate = session.handle.correlate
      const waiter =
        correlate === undefined
          ? null
          : takeWaiter(session.waiting, correlate, payload, deps.onHookError)
      if (waiter !== null) {
        session.lastActivityMs = deps.now()
        waiter.resolve(payload)
        return
      }
      if (session.inFlight !== null) {
        const pending = session.inFlight
        session.inFlight = null
        session.lastActivityMs = deps.now()
        pending.resolve(payload)
        return
      }
      if (session.stream !== null && session.stream.isOpen()) {
        session.stream.send(payload)
        return
      }
      // Nothing settled and nobody is listening: keep it, bounded, for the
      // stream that may yet open.
      session.buffered = deps.buffer(session.buffered, payload)
    },
  })
}
