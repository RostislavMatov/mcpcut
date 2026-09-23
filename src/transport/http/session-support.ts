import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import type { MessageSink, MessageSource } from '../message.js'
import {
  CONTENT_TYPE_JSON,
  HTTP_STATUS_NOT_FOUND,
  MCP_SESSION_ID_HEADER,
} from './constants.js'
import {
  BODY_BAD_REQUEST,
  BODY_NOT_FOUND,
  BODY_SESSION_NOT_FOUND,
  BODY_UPSTREAM_TIMEOUT,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_GATEWAY_TIMEOUT,
  REFUSAL_CODE_PATTERN,
} from './server-constants.js'

/**
 * Contracts and small pure helpers for the downstream session manager
 * (`session.ts`). Split out purely for the < 400-lines-per-file rule (the
 * same precedent as `client-wire.ts` for Task 9's client) — the public
 * surface stays on `session.ts`, which re-exports everything here.
 */

/** Identity of the (agent, server) pair a request was routed to. */
export interface SessionContext {
  readonly agentName: string
  readonly serverName: string
}

/**
 * How a session pairs replies with requests. A session that declares it may
 * hold SEVERAL POSTs in flight at once; one that does not keeps the older rule
 * ("the answer is the next message this session emits", one at a time).
 *
 * Both hooks take raw bytes, because this module must not learn JSON-RPC
 * (ADR-0001). What a "key" means is the injector's business; the manager only
 * ever compares them.
 */
export interface ResponseCorrelation {
  /** Key of an outgoing request body, or `null` when it is owed no answer. */
  keyOfRequest(bytes: Buffer): string | null
  /** Key of an inbound payload, or `null` when it answers nothing. */
  keyOfResponse(bytes: Buffer): string | null
}

/** A live upstream conversation produced by the injected factory. */
export interface OpenedSession {
  readonly sink: MessageSink
  readonly source: MessageSource
  /**
   * Opt-in id correlation (pool sessions). Absent — the per-server case —
   * means today's positional pairing, unchanged.
   */
  readonly correlate?: ResponseCorrelation
  close(): Promise<void>
}

/** Factory refusal; `error` names the reason (`'unknown-server'`, ...). */
export interface OpenSessionRefusal {
  readonly error: string
}

/** Injected session factory (the real one is wired by Task 13's `serve`). */
export type OpenSession = (ctx: SessionContext) => Promise<OpenedSession | OpenSessionRefusal>

/** Semantic hook: is this body an `initialize` request? Default: never. */
export type DetectInitialize = (bytes: Buffer) => boolean

/** Semantic hook result for stateless header↔body validation. */
export type StatelessValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorBody: Buffer }

/** Semantic hook: stateless header↔body validation (`-32020`). Default: always ok. */
export type ValidateStatelessHeaders = (
  headers: IncomingHttpHeaders,
  bytes: Buffer,
) => StatelessValidation

/** Semantic hook: does this body expect a response (request) or not (notification → 202)? */
export type ExpectsResponse = (bytes: Buffer) => boolean

/** What the server should answer; `body` implies `application/json` unless a header says otherwise. */
export interface ResponsePlan {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Buffer
}

export interface SessionManagerOptions {
  readonly openSession: OpenSession
  readonly detectInitialize?: DetectInitialize
  readonly validateStatelessHeaders?: ValidateStatelessHeaders
  readonly expectsResponse?: ExpectsResponse
  readonly maxSessions?: number
  /** Requests ONE correlating session may hold at once; default `MAX_CORRELATED_IN_FLIGHT`. */
  readonly maxCorrelatedInFlight?: number
  /**
   * Sessions this manager did not open but which share its budget — a pool's
   * children each cost an upstream exactly as a per-server session does.
   *
   * Semantics-free: the manager only adds the number. Read synchronously inside
   * `reserve()`, before any await, so it must be cheap — a counter, not a store.
   */
  readonly extraSessions?: () => number
  /**
   * Free one slot of the shared budget if you can; synchronous. Asked only
   * when the budget is full, inside `reserve()`, before any await; `true`
   * means a slot was freed and the budget is looked at once more.
   *
   * Semantics-free like `extraSessions`: the manager only asks.
   */
  readonly reclaimSessions?: () => boolean
  readonly idleTtlMs?: number
  readonly sweepIntervalMs?: number
  readonly heartbeatIntervalMs?: number
  readonly maxBufferedMessages?: number
  /** Byte budget for the same buffer; whichever cap binds first evicts. */
  readonly maxBufferedBytes?: number
  /** How long a stateless POST waits for its one answer before 504. */
  readonly statelessTimeoutMs?: number
  /** Session id minting override for tests; default `crypto.randomUUID`. */
  readonly uuid?: () => string
  /** Clock override for TTL tests; default `Date.now`. */
  readonly now?: () => number
  /** Diagnostic sink for session errors; never receives bodies or headers. */
  readonly onSessionError?: (sessionId: string, error: unknown) => void
  /**
   * Called when a POST consulted the semantic hooks but will NOT open a
   * session after all (today: stateless header validation refused it).
   * Hooks may carry per-request state handed to `openSession` out of band
   * — the injector uses this to drop it. Semantics-free by design: this
   * module neither knows nor asks what the state is.
   */
  readonly onOpenAbandoned?: () => void
}

/** Per-request knobs a caller may attach to one POST. */
export interface PostOptions {
  /** Aborted when the agent's own socket goes away; releases the upstream. */
  readonly signal?: AbortSignal
}

export interface SessionManager {
  handlePost(
    ctx: SessionContext,
    headers: IncomingHttpHeaders,
    body: Buffer,
    options?: PostOptions,
  ): Promise<ResponsePlan>
  /** Returns `'attached'` when the response became a live SSE stream. */
  handleGet(
    ctx: SessionContext,
    headers: IncomingHttpHeaders,
    res: ServerResponse,
  ): ResponsePlan | 'attached'
  handleDelete(ctx: SessionContext, headers: IncomingHttpHeaders): Promise<ResponsePlan>
  /** Sessions occupying a slot: registered ones plus opens still in flight. */
  activeSessionCount(): number
  /** Tears every session down (upstream close, streams ended) and stops the sweeper. */
  close(): Promise<void>
}

/** Signals that a session died while a request waited on its response. */
export class SessionTornDownError extends Error {
  constructor() {
    super('session torn down while a request was in flight')
    this.name = 'SessionTornDownError'
  }
}

/** Signals that no answer arrived within the request's own time budget. */
export class UpstreamTimeoutError extends Error {
  constructor() {
    super('upstream produced no response within the request timeout')
    this.name = 'UpstreamTimeoutError'
  }
}

/** Signals that the agent's socket went away before its answer existed. */
export class RequestAbortedError extends Error {
  constructor() {
    super('request abandoned by the client')
    this.name = 'RequestAbortedError'
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** First `Mcp-Session-Id` value, if any. Node lowercases header names, so lookup is case-insensitive. */
export function sessionIdOf(headers: IncomingHttpHeaders): string | null {
  const raw = headers[MCP_SESSION_ID_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function jsonPlan(
  status: number,
  body: Buffer,
  headers?: Record<string, string>,
): ResponsePlan {
  return Object.freeze({
    status,
    body,
    headers: Object.freeze({ 'content-type': CONTENT_TYPE_JSON, ...headers }),
  })
}

/** The refusal code the factory names when the server is not in the registry. */
const UNKNOWN_SERVER_REFUSAL = 'unknown-server'

/**
 * The refusal code for an authenticated agent with no grant for the server it
 * addressed (`cli/serve-constants.ts`, restated here because the transport must
 * not import the semantic layer — ADR-0001's invariant, same as above).
 */
const NO_GRANT_REFUSAL = 'no-grant'

/**
 * The part of a refusal that may reach an agent: the leading code token,
 * and only when it is code-shaped. `"protocol-mismatch: server \"x\" is
 * registered as stateless — see docs/adr/..."` becomes `protocol-mismatch`;
 * anything unrecognizable becomes nothing at all. Refusal prose describes
 * the plane's registry and its decisions, which are operator information.
 */
function refusalCodeOf(error: string): string | null {
  const code = (error.split(':', 1)[0] ?? '').trim()
  return REFUSAL_CODE_PATTERN.test(code) ? code : null
}

/**
 * Maps a factory refusal to a plan: unknown server → 404, no grant → 403,
 * anything else → 400.
 *
 * 403 for `no-grant` (user-journey smoke 2026-09-18, UX-11): the agent
 * authenticated, sent a well-formed request, and was refused for WHO it is.
 * 400 was only ever the catch-all, and it told a client to look for a mistake
 * in its own bytes. 400 remains right for everything else here — the
 * session-model mismatch ADR-0002 pins, and the vault/secret refusals, which
 * are all statements about the request or the server it names, not about the
 * caller's authorization.
 */
export function refusalPlan(refusal: OpenSessionRefusal): ResponsePlan {
  const code = refusalCodeOf(refusal.error)
  if (code === null) {
    return jsonPlan(HTTP_STATUS_BAD_REQUEST, BODY_BAD_REQUEST)
  }
  if (code === UNKNOWN_SERVER_REFUSAL) {
    return jsonPlan(HTTP_STATUS_NOT_FOUND, BODY_NOT_FOUND)
  }
  const body = Buffer.from(JSON.stringify({ error: code }), 'utf8')
  if (code === NO_GRANT_REFUSAL) {
    return jsonPlan(HTTP_STATUS_FORBIDDEN, body)
  }
  return jsonPlan(HTTP_STATUS_BAD_REQUEST, body)
}

/**
 * How a request that never got its answer is reported:
 *
 *  - the session died first (upstream ended, manager closing) → 404, the
 *    same answer a terminated sessionful session gives (matrix §1.5);
 *  - nothing came in time, or the agent left → 504 with one uniform body
 *    (see `BODY_UPSTREAM_TIMEOUT`).
 *
 * Anything else is a genuine bug and is re-thrown for the 500 branch.
 */
export function abandonedRequestPlan(error: unknown): ResponsePlan {
  if (error instanceof SessionTornDownError) {
    return jsonPlan(HTTP_STATUS_NOT_FOUND, BODY_SESSION_NOT_FOUND)
  }
  if (error instanceof UpstreamTimeoutError || error instanceof RequestAbortedError) {
    return jsonPlan(HTTP_STATUS_GATEWAY_TIMEOUT, BODY_UPSTREAM_TIMEOUT)
  }
  throw error
}

/** A pending wait for the single message a one-shot session owes a request. */
export interface FirstMessageWait {
  readonly promise: Promise<Buffer>
  /** Ends the wait with `error` unless it already settled. */
  fail(error: unknown): void
  /** Releases the timer and the abort listener. Idempotent. */
  cancel(): void
}

export interface FirstMessageOptions {
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
}

/**
 * Waits for the first message `source` produces, bounded on every side a
 * one-shot exchange can fail on: an error, the source ending without an
 * answer, the timeout, and the agent going away. The timer is unref'ed —
 * a pending stateless request must not keep the process alive.
 */
export function awaitFirstMessage(
  source: MessageSource,
  opts: FirstMessageOptions,
): FirstMessageWait {
  const deferred = createDeferred<Buffer>()
  // Marks the promise handled the moment it exists: it may reject before
  // the caller awaits it (an already-dead upstream ends synchronously),
  // and an unhandled rejection would take the process down.
  void deferred.promise.catch(() => undefined)

  source.onMessage((message) => deferred.resolve(message.bytes))
  source.onError((error: unknown) => deferred.reject(error))
  source.onEnd(() => deferred.reject(new SessionTornDownError()))

  const timer = setTimeout(() => deferred.reject(new UpstreamTimeoutError()), opts.timeoutMs)
  timer.unref()
  const onAbort = (): void => deferred.reject(new RequestAbortedError())
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  if (opts.signal?.aborted === true) {
    onAbort()
  }

  let isCancelled = false
  return Object.freeze({
    promise: deferred.promise,
    fail: (error: unknown) => deferred.reject(error),
    cancel: (): void => {
      if (isCancelled) return
      isCancelled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    },
  })
}

export { createSlotCounter, type SessionSlot, type SlotCounter } from './session-slots.js'

/** A bounded message buffer: the payloads kept, and their total size. */
export interface BufferedMessages {
  readonly payloads: readonly Buffer[]
  readonly bytes: number
}

export const EMPTY_BUFFER: BufferedMessages = Object.freeze({
  payloads: Object.freeze([]) as readonly Buffer[],
  bytes: 0,
})

/**
 * Appends `payload`, then drops the OLDEST entries until both caps hold
 * (decision §4.1: undelivered server-initiated messages are lost anyway,
 * and the recent ones are the more useful to keep). A payload bigger than
 * the whole byte budget evicts everything and then itself — it could never
 * be delivered without breaking the promise the budget makes.
 */
export function appendBuffered(
  current: BufferedMessages,
  payload: Buffer,
  maxMessages: number,
  maxBytes: number,
): BufferedMessages {
  const payloads = [...current.payloads, payload]
  let bytes = current.bytes + payload.length
  let start = 0
  while (start < payloads.length && (payloads.length - start > maxMessages || bytes > maxBytes)) {
    bytes -= (payloads[start] as Buffer).length
    start += 1
  }
  return Object.freeze({ payloads: start === 0 ? payloads : payloads.slice(start), bytes })
}
