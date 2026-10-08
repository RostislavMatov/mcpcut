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
  abandonedRequestPlan,
  createDeferred,
  jsonPlan,
  RequestAbortedError,
  SessionTornDownError,
  type BufferedMessages,
  type Deferred,
  type ExpectsResponse,
  type OpenedSession,
  type PostOptions,
  type ProgressCorrelation,
  type ResponseCorrelation,
  type ResponsePlan,
} from './session-support.js'
import { startPostStream, STREAMED, type PostStream, type Streamed } from './session-post-stream.js'

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

export { correlationKeyOf, registerWaiter, rejectAllWaiting, takeWaiter, type RegisterOutcome } from './session-waiting.js'
import { correlationKeyOf, registerWaiter, takeWaiter } from './session-waiting.js'

// ---------------------------------------------------------------------------
// The two pairing rules
// ---------------------------------------------------------------------------

/**
 * The part of a live session these rules touch. Declared structurally rather
 * than importing `ActiveSession`: this module has no business with a session's
 * id or its (agent, server) pair, and saying so in the type keeps it that way.
 */
export interface PairedSession {
  readonly handle: OpenedSession
  readonly waiting: Map<string, Deferred<Buffer>>
  lastActivityMs: number
  inFlight: Deferred<Buffer> | null
  buffered: BufferedMessages
  /** Present and open when the agent holds a GET stream. */
  readonly stream: { isOpen(): boolean; send(payload: Buffer): void } | null
  /** The POST streams of this session's waiting requests, by progress key (M36 phase B). */
  readonly related: Map<string, PostStream>
  /** Response keys of correlated requests the agent abandoned: their late answer is dropped, not re-routed. */
  readonly abandoned: Set<string>
  /** Ends the session; a positional one cannot survive an abandoned request. */
  readonly end: () => void
}

export interface ExchangeRulesDeps {
  readonly expectsResponse: ExpectsResponse
  /** Requests ONE correlating session may hold at once; also bounds `abandoned`. */
  readonly maxCorrelatedInFlight: number
  readonly now: () => number
  /** Appends to the bounded server-message buffer (count and byte capped). */
  readonly buffer: (current: BufferedMessages, payload: Buffer) => BufferedMessages
  /** Reports a correlation-hook failure; it belongs to no one session. */
  readonly onHookError: (error: unknown) => void
  /** Routes a request's progress onto its own POST; absent — nothing is related to a POST. */
  readonly progress: ProgressCorrelation | undefined
  /** How long a POST answers with JSON before it becomes an SSE stream. */
  readonly postStreamAfterMs: number
}

/** What answering one POST came to: a plan for the front to write, or an answer already streamed. */
export type PostOutcome = ResponsePlan | Streamed

export interface ExchangeRules {
  /** Answers one POST on an existing session, by whichever rule it declared. */
  post(session: PairedSession, body: Buffer, options?: PostOptions): Promise<PostOutcome>
  /** Writes `body` and answers with the session's next message (the handshake path). */
  exchange(session: PairedSession, body: Buffer): Promise<ResponsePlan>
  /** Delivers one server-origin payload: waiter > abandoned > related POST > in-flight > stream > buffer. */
  deliver(session: PairedSession, payload: Buffer): void
}

/** One wait for an answer, with what to do if the agent walks away from it. */
interface AnswerWait {
  readonly session: PairedSession
  readonly body: Buffer
  readonly pending: Deferred<Buffer>
  unregister(): void
  /** The agent's request closed before the answer (phase B). */
  abandon(): void
  readonly options: PostOptions | undefined
}

const NOOP = (): void => undefined

/** Runs `onAbort` when `signal` aborts (now, or later); returns the listener's release. */
function onAbort(signal: AbortSignal | undefined, abort: () => void): () => void {
  if (signal === undefined) return NOOP
  if (signal.aborted) {
    abort()
    return NOOP
  }
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

export function createExchangeRules(deps: ExchangeRulesDeps): ExchangeRules {
  /** The progress key `bytes` carries on `side`, or `null`; a throwing hook relates nothing. */
  function progressKeyOf(side: keyof ProgressCorrelation, bytes: Buffer): string | null {
    if (deps.progress === undefined) return null
    try {
      return deps.progress[side](bytes)
    } catch (error: unknown) {
      deps.onHookError(error)
      return null
    }
  }

  /** Files this POST's stream under the progress its request asks for; first holder of a key wins. */
  function relate(session: PairedSession, body: Buffer, stream: PostStream): () => void {
    const key = progressKeyOf('keyOfRequest', body)
    if (key === null || session.related.has(key)) return NOOP
    session.related.set(key, stream)
    return () => {
      if (session.related.get(key) === stream) session.related.delete(key)
    }
  }

  /**
   * Writes `body` into the session and awaits the answer it was registered
   * for, undoing the registration on any failure. Shared by both rules so the
   * teardown → 404 mapping cannot drift between them. The answer is the plain
   * JSON it always was, unless the POST became a stream on the way
   * (`session-post-stream.ts`).
   */
  async function awaitAnswer(wait: AnswerWait): Promise<PostOutcome> {
    const { session, body, pending, options } = wait
    const stream = startPostStream({ open: options?.openStream, upgradeAfterMs: deps.postStreamAfterMs })
    const releaseRelated = relate(session, body, stream)
    const releaseAbort = onAbort(options?.signal, () => pending.reject(new RequestAbortedError()))
    try {
      await session.handle.sink.write(clientMessage(body))
      const payload = await pending.promise
      return stream.finish(payload) ?? jsonPlan(HTTP_STATUS_OK, payload)
    } catch (error: unknown) {
      wait.unregister()
      if (error instanceof RequestAbortedError) wait.abandon()
      const streamed = stream.abort()
      if (streamed !== null) return streamed
      if (error instanceof SessionTornDownError) {
        return jsonPlan(HTTP_STATUS_NOT_FOUND, BODY_SESSION_NOT_FOUND)
      }
      // Nobody reads it; the plan only completes the handler's contract.
      if (error instanceof RequestAbortedError) return abandonedRequestPlan(error)
      throw error
    } finally {
      releaseRelated()
      releaseAbort()
    }
  }

  /** A body owed no answer: written and acknowledged, never registered. */
  async function acknowledge(session: PairedSession, body: Buffer): Promise<ResponsePlan> {
    await session.handle.sink.write(clientMessage(body))
    return Object.freeze({ status: HTTP_STATUS_ACCEPTED })
  }

  async function positional(session: PairedSession, body: Buffer, options?: PostOptions): Promise<PostOutcome> {
    if (!deps.expectsResponse(body)) {
      return acknowledge(session, body)
    }
    const pending = createDeferred<Buffer>()
    session.inFlight = pending
    return awaitAnswer({
      session,
      body,
      pending,
      options,
      unregister: () => {
        if (session.inFlight === pending) {
          session.inFlight = null
        }
      },
      // "The answer is the next message" cannot survive a request whose answer
      // may never come (a held call withdrawn) or come late to the wrong POST:
      // the session ends, which withdraws whatever it held.
      abandon: () => session.end(),
    })
  }

  /** Remembers an abandoned request's key so its late answer is dropped; bounded, oldest out. */
  function rememberAbandoned(session: PairedSession, key: string): void {
    if (session.abandoned.size >= deps.maxCorrelatedInFlight) {
      const oldest = session.abandoned.values().next()
      if (oldest.done !== true) session.abandoned.delete(oldest.value)
    }
    session.abandoned.add(key)
  }

  async function correlated(
    session: PairedSession,
    correlate: ResponseCorrelation,
    body: Buffer,
    options?: PostOptions,
  ): Promise<PostOutcome> {
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
    return awaitAnswer({
      session,
      body,
      pending: registered.pending,
      options,
      unregister: registered.unregister,
      abandon: () => {
        rememberAbandoned(session, registered.key)
        session.handle.abandon?.(body)
      },
    })
  }

  /** A late answer to a request its agent abandoned: dropped, never handed to another reader. */
  function dropAbandoned(session: PairedSession, correlate: ResponseCorrelation, payload: Buffer): boolean {
    if (session.abandoned.size === 0) return false
    const key = correlationKeyOf(correlate, 'keyOfResponse', payload, deps.onHookError)
    return key !== null && session.abandoned.delete(key)
  }

  /**
   * Progress on a waiting request goes out on that request's own POST. A POST
   * that cannot stream (the client did not accept SSE) hands it to the GET
   * stream if one is open and otherwise drops it — never to the in-flight
   * POST, which would read it as its answer.
   */
  function deliverRelated(session: PairedSession, payload: Buffer): boolean {
    if (session.related.size === 0) return false
    const key = progressKeyOf('keyOfNotification', payload)
    const target = key === null ? undefined : session.related.get(key)
    if (target === undefined) return false
    if (!target.send(payload) && session.stream !== null && session.stream.isOpen()) {
      session.stream.send(payload)
    }
    return true
  }

  return Object.freeze({
    async exchange(session: PairedSession, body: Buffer): Promise<ResponsePlan> {
      const outcome = await positional(session, body)
      // Without `openStream` no answer can stream; the handshake never offers one.
      if (outcome === STREAMED) throw new Error('a handshake answer cannot stream')
      return outcome
    },

    post(session: PairedSession, body: Buffer, options?: PostOptions): Promise<PostOutcome> {
      const correlate = session.handle.correlate
      if (correlate !== undefined) {
        // Stamped on REGISTRATION, not only on the answer: a pool call held by
        // a human approval, on a session with no GET stream, would otherwise
        // be swept by the idle sweeper mid-wait.
        session.lastActivityMs = deps.now()
        return correlated(session, correlate, body, options)
      }
      if (session.inFlight !== null) {
        return Promise.resolve(jsonPlan(HTTP_STATUS_CONFLICT, BODY_REQUEST_IN_FLIGHT))
      }
      session.lastActivityMs = deps.now()
      return positional(session, body, options)
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
      if (correlate !== undefined && dropAbandoned(session, correlate, payload)) return
      if (deliverRelated(session, payload)) return
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
