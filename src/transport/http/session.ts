import { randomUUID } from 'node:crypto'
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import {
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_NOT_FOUND,
  MCP_SESSION_ID_HEADER,
} from './constants.js'
import {
  BODY_BAD_REQUEST,
  BODY_METHOD_NOT_ALLOWED,
  BODY_SESSION_NOT_FOUND,
  BODY_TOO_MANY_SESSIONS,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_NO_CONTENT,
  HTTP_STATUS_OK,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  MAX_BUFFERED_SERVER_BYTES,
  MAX_BUFFERED_SERVER_MESSAGES,
  MAX_CONCURRENT_SESSIONS,
  MAX_CORRELATED_IN_FLIGHT,
  SESSION_IDLE_TTL_MS,
  SESSION_SWEEP_INTERVAL_MS,
  SSE_HEARTBEAT_INTERVAL_MS,
  STATELESS_RESPONSE_TIMEOUT_MS,
} from './server-constants.js'
import { createStatelessRunner } from './session-stateless.js'
import {
  appendBuffered,
  EMPTY_BUFFER,
  jsonPlan,
  refusalPlan,
  sessionIdOf,
  SessionTornDownError,
  type BufferedMessages,
  type Deferred,
  type OpenedSession,
  type PostOptions,
  type ResponsePlan,
  type SessionContext,
  type SessionManager,
  type SessionManagerOptions,
  type StatelessValidation,
} from './session-support.js'
import { createSlotCounter, type SessionSlot } from './session-slots.js'
import { createExchangeRules, rejectAllWaiting } from './session-exchange.js'
import { openSseStream, type SseStream } from './sse.js'

/**
 * Label a correlation-hook failure is reported under. The hooks belong to a
 * session's FACTORY, not to one request, so no session id would be the honest
 * answer here.
 */
const CORRELATION_ERROR_LABEL = 'correlation'

/**
 * Downstream session manager: both HTTP session models of ADR-0002 behind
 * one POST/GET/DELETE surface, with ALL protocol semantics injected as
 * hooks (real ones arrive from session-core, Tasks 11/13 — defaults here
 * are semantics-free, so this module never learns JSON-RPC).
 *
 * - `detectInitialize(body)` true on a POST without a session id →
 *   sessionful: a session is opened, its id is `crypto.randomUUID()` (spec
 *   SHOULD cryptographically secure — matrix §4.3), the response carries
 *   `Mcp-Session-Id`, and later POSTs with that id reach the same session.
 * - no session id and not initialize → stateless: a one-shot session whose
 *   single response is the HTTP response — `session-stateless.ts`, which
 *   documents how such an exchange is bounded on every side.
 *
 * Decisions this module documents (test-pinned):
 * - ONE in-flight POST request per session; a second parallel request
 *   answers 409 `{"error":"request-in-flight"}`. Sessions are per-agent-
 *   per-server and MCP traffic through the plane is sequential; a queue
 *   would only hide upstream slowness and complicate correlation (the
 *   response to a POST is "the next message the session emits").
 *   A session MAY opt out by declaring `correlate` (ADR-0015 phase 3, plan
 *   decision P1): the manager then keys waiting requests by whatever the
 *   injected hooks return and holds up to `maxCorrelatedInFlight` of them.
 *   One pool address fans an agent's calls across several upstreams, and one
 *   call held by a human approval would otherwise 409 every other. Sessions
 *   that declare nothing take the branch above, unchanged.
 * - Server-initiated routing: `source.onMessage` receives everything; a
 *   message arriving while a POST request is in flight IS that request's
 *   response; otherwise it goes to the open GET stream, or into a buffer
 *   bounded in BOTH count and bytes (oldest dropped past either cap),
 *   flushed when a GET stream opens.
 * - A second GET stream REPLACES the first (old one closed): the likely
 *   cause is a client reconnect whose dead socket we haven't noticed yet,
 *   and the spec forbids duplicating messages across streams.
 * - Idle sessions are evicted after `idleTtlMs` (sweeper on an unref'ed
 *   timer), EXCEPT sessions holding an open GET stream — those are live by
 *   definition (the heartbeat keeps the socket warm). A request in flight
 *   when its session dies (TTL, DELETE, shutdown) answers 404 — matrix §1.5:
 *   a terminated session answers 404 from that point on.
 * - `maxSessions` counts BOTH models and is reserved synchronously, before
 *   any hook runs and before the `openSession` await — a check that
 *   straddled the await would let N parallel initializes all pass it, and
 *   a cap that ignored one-shots would not be a cap at all. `extraSessions`
 *   adds sessions this manager did not open but which cost the same process
 *   resources (a pool session's children).
 */

// Contracts live in session-support.ts (file-size split); public surface stays here.
export {
  RequestAbortedError,
  SessionTornDownError,
  UpstreamTimeoutError,
  type DetectInitialize,
  type ExpectsResponse,
  type OpenedSession,
  type OpenSession,
  type OpenSessionRefusal,
  type PostOptions,
  type ResponseCorrelation,
  type ResponsePlan,
  type SessionContext,
  type SessionManager,
  type SessionManagerOptions,
  type SessionSlot,
  type StatelessValidation,
  type ValidateStatelessHeaders,
} from './session-support.js'

interface ActiveSession {
  readonly id: string
  readonly agentName: string
  readonly serverName: string
  readonly handle: OpenedSession
  lastActivityMs: number
  inFlight: Deferred<Buffer> | null
  /** Requests keyed by `correlate`; always empty for a session without it. */
  readonly waiting: Map<string, Deferred<Buffer>>
  buffered: BufferedMessages
  stream: SseStream | null
}

export function createSessionManager(opts: SessionManagerOptions): SessionManager {
  const detectInitialize = opts.detectInitialize ?? (() => false)
  const validateStatelessHeaders =
    opts.validateStatelessHeaders ?? ((): StatelessValidation => ({ ok: true }))
  const expectsResponse = opts.expectsResponse ?? (() => true)
  const maxSessions = opts.maxSessions ?? MAX_CONCURRENT_SESSIONS
  const idleTtlMs = opts.idleTtlMs ?? SESSION_IDLE_TTL_MS
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS
  const maxBuffered = opts.maxBufferedMessages ?? MAX_BUFFERED_SERVER_MESSAGES
  const maxBufferedBytes = opts.maxBufferedBytes ?? MAX_BUFFERED_SERVER_BYTES
  const statelessTimeoutMs = opts.statelessTimeoutMs ?? STATELESS_RESPONSE_TIMEOUT_MS
  const maxCorrelatedInFlight = opts.maxCorrelatedInFlight ?? MAX_CORRELATED_IN_FLIGHT
  const uuid = opts.uuid ?? randomUUID
  const now = opts.now ?? Date.now

  const sessions = new Map<string, ActiveSession>()
  /**
   * Both POST pairing rules and the inbound-payload cascade, in one module so
   * they cannot drift apart (`session-exchange.ts`).
   */
  const rules = createExchangeRules({
    expectsResponse,
    maxCorrelatedInFlight,
    now,
    buffer: (current, payload) => appendBuffered(current, payload, maxBuffered, maxBufferedBytes),
    // The hooks belong to a session's FACTORY, not to one request, so no
    // session id would be the honest answer here.
    onHookError: (error) => opts.onSessionError?.(CORRELATION_ERROR_LABEL, error),
  })
  const stateless = createStatelessRunner({
    openSession: opts.openSession,
    validateStatelessHeaders,
    expectsResponse,
    timeoutMs: statelessTimeoutMs,
    onOpenAbandoned: opts.onOpenAbandoned,
  })
  /** Registered sessions plus whatever else shares this manager's budget (P5). */
  const countRegistered = (): number => sessions.size + (opts.extraSessions?.() ?? 0)
  const slots = createSlotCounter(maxSessions, countRegistered, opts.reclaimSessions)
  let isManagerClosed = false

  const sweeper = setInterval(sweepIdleSessions, opts.sweepIntervalMs ?? SESSION_SWEEP_INTERVAL_MS)
  sweeper.unref()

  function sweepIdleSessions(): void {
    const cutoff = now() - idleTtlMs
    for (const session of sessions.values()) {
      const hasOpenStream = session.stream !== null && session.stream.isOpen()
      if (!hasOpenStream && session.lastActivityMs < cutoff) {
        void teardownSession(session)
      }
    }
  }

  async function teardownSession(session: ActiveSession): Promise<void> {
    if (!sessions.has(session.id)) {
      return
    }
    sessions.delete(session.id)
    session.inFlight?.reject(new SessionTornDownError())
    session.inFlight = null
    // Every correlated waiter becomes the same 404 the single positional one
    // has always become (matrix §1.5: a terminated session answers 404).
    rejectAllWaiting(session.waiting, () => new SessionTornDownError())
    session.stream?.close()
    session.stream = null
    session.handle.source.dispose()
    try {
      await session.handle.close()
    } catch (error: unknown) {
      opts.onSessionError?.(session.id, error)
    }
  }

  /** The session for this id, only if it belongs to the SAME (agent, server) pair. */
  function lookupSession(ctx: SessionContext, id: string): ActiveSession | undefined {
    const session = sessions.get(id)
    if (
      session === undefined ||
      session.agentName !== ctx.agentName ||
      session.serverName !== ctx.serverName
    ) {
      return undefined
    }
    return session
  }

  function registerSession(ctx: SessionContext, handle: OpenedSession): ActiveSession {
    const session: ActiveSession = {
      id: uuid(),
      agentName: ctx.agentName,
      serverName: ctx.serverName,
      handle,
      lastActivityMs: now(),
      inFlight: null,
      waiting: new Map(),
      buffered: EMPTY_BUFFER,
      stream: null,
    }
    sessions.set(session.id, session)
    handle.source.onMessage((message) => rules.deliver(session, message.bytes))
    handle.source.onError((error: unknown) => opts.onSessionError?.(session.id, error))
    handle.source.onEnd(() => void teardownSession(session))
    return session
  }

  async function handleInitializePost(
    ctx: SessionContext,
    body: Buffer,
    slot: SessionSlot,
  ): Promise<ResponsePlan> {
    const opened = await opts.openSession(ctx)
    if ('error' in opened) {
      return refusalPlan(opened)
    }
    const session = registerSession(ctx, opened)
    // The session now occupies a slot of its own (`sessions.size`).
    slot.release()
    let plan: ResponsePlan
    try {
      plan = await rules.exchange(session, body)
    } catch (error: unknown) {
      // A broken handshake must not leave a half-alive session behind.
      await teardownSession(session)
      throw error
    }
    const responseBody = plan.body
    if (plan.status !== HTTP_STATUS_OK || responseBody === undefined) {
      return plan
    }
    return Object.freeze({
      status: plan.status,
      body: responseBody,
      headers: Object.freeze({ ...plan.headers, [MCP_SESSION_ID_HEADER]: session.id }),
    })
  }

  async function handlePost(
    ctx: SessionContext,
    headers: IncomingHttpHeaders,
    body: Buffer,
    options?: PostOptions,
  ): Promise<ResponsePlan> {
    const sessionId = sessionIdOf(headers)
    if (sessionId !== null) {
      const session = lookupSession(ctx, sessionId)
      if (session === undefined) {
        return jsonPlan(HTTP_STATUS_NOT_FOUND, BODY_SESSION_NOT_FOUND)
      }
      return rules.post(session, body)
    }
    // A POST without a session id opens one, in either model. Take the slot
    // BEFORE the hooks run: the cap must not straddle an await, and a
    // refused request must not leave per-request hook state behind either.
    const slot = slots.reserve()
    if (slot === null) {
      return jsonPlan(HTTP_STATUS_TOO_MANY_REQUESTS, BODY_TOO_MANY_SESSIONS)
    }
    try {
      return detectInitialize(body)
        ? await handleInitializePost(ctx, body, slot)
        : await stateless.handle(ctx, headers, body, options)
    } finally {
      slot.release()
    }
  }

  function handleGet(
    ctx: SessionContext,
    headers: IncomingHttpHeaders,
    res: ServerResponse,
  ): ResponsePlan | 'attached' {
    const sessionId = sessionIdOf(headers)
    if (sessionId === null) {
      // No sessionful session on this request → this endpoint offers no stream (spec: SSE or 405).
      return jsonPlan(HTTP_STATUS_METHOD_NOT_ALLOWED, BODY_METHOD_NOT_ALLOWED)
    }
    const session = lookupSession(ctx, sessionId)
    if (session === undefined) {
      return jsonPlan(HTTP_STATUS_NOT_FOUND, BODY_SESSION_NOT_FOUND)
    }
    session.lastActivityMs = now()
    session.stream?.close()
    const stream = openSseStream(res, {
      heartbeatIntervalMs,
      onClose: () => {
        if (session.stream === stream) {
          session.stream = null
        }
      },
    })
    session.stream = stream
    const backlog = session.buffered.payloads
    session.buffered = EMPTY_BUFFER
    for (const payload of backlog) {
      stream.send(payload)
    }
    return 'attached'
  }

  async function handleDelete(
    ctx: SessionContext,
    headers: IncomingHttpHeaders,
  ): Promise<ResponsePlan> {
    const sessionId = sessionIdOf(headers)
    if (sessionId === null) {
      return jsonPlan(HTTP_STATUS_BAD_REQUEST, BODY_BAD_REQUEST)
    }
    const session = lookupSession(ctx, sessionId)
    if (session === undefined) {
      return jsonPlan(HTTP_STATUS_NOT_FOUND, BODY_SESSION_NOT_FOUND)
    }
    await teardownSession(session)
    return Object.freeze({ status: HTTP_STATUS_NO_CONTENT })
  }

  async function close(): Promise<void> {
    if (isManagerClosed) {
      return
    }
    isManagerClosed = true
    clearInterval(sweeper)
    // In-flight one-shots are not in `sessions`; the runner ends them and
    // resolves once their upstreams have been closed.
    await Promise.all([
      ...[...sessions.values()].map((session) => teardownSession(session)),
      stateless.terminateAll(),
    ])
  }

  return Object.freeze({
    handlePost,
    handleGet,
    handleDelete,
    activeSessionCount: () => countRegistered() + slots.reserved(),
    close,
  })
}
