import { randomUUID } from 'node:crypto'
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import { clientMessage } from '../message.js'
import {
  HTTP_STATUS_ACCEPTED,
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_NOT_FOUND,
  MCP_SESSION_ID_HEADER,
} from './constants.js'
import {
  BODY_BAD_REQUEST,
  BODY_METHOD_NOT_ALLOWED,
  BODY_REQUEST_IN_FLIGHT,
  BODY_SESSION_NOT_FOUND,
  BODY_TOO_MANY_SESSIONS,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_CONFLICT,
  HTTP_STATUS_NO_CONTENT,
  HTTP_STATUS_OK,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  MAX_BUFFERED_SERVER_MESSAGES,
  MAX_CONCURRENT_SESSIONS,
  SESSION_IDLE_TTL_MS,
  SESSION_SWEEP_INTERVAL_MS,
  SSE_HEARTBEAT_INTERVAL_MS,
} from './server-constants.js'
import {
  createDeferred,
  jsonPlan,
  refusalPlan,
  sessionIdOf,
  SessionTornDownError,
  type Deferred,
  type DetectInitialize,
  type ExpectsResponse,
  type OpenedSession,
  type OpenSession,
  type ResponsePlan,
  type SessionContext,
  type SessionManager,
  type SessionManagerOptions,
  type StatelessValidation,
  type ValidateStatelessHeaders,
} from './session-support.js'
import { openSseStream, type SseStream } from './sse.js'

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
 * - no session id and not initialize → stateless: `validateStatelessHeaders`
 *   first (mismatch → 400 with the hook's body), then a one-shot session
 *   whose single response is the HTTP response; the session closes after.
 *
 * Decisions this module documents (test-pinned):
 * - ONE in-flight POST request per session; a second parallel request
 *   answers 409 `{"error":"request-in-flight"}`. Sessions are per-agent-
 *   per-server and MCP traffic through the plane is sequential; a queue
 *   would only hide upstream slowness and complicate correlation (the
 *   response to a POST is "the next message the session emits").
 * - Server-initiated routing: `source.onMessage` receives everything; a
 *   message arriving while a POST request is in flight IS that request's
 *   response; otherwise it goes to the open GET stream, or into a bounded
 *   buffer (oldest dropped past the cap) flushed when a GET stream opens.
 * - A second GET stream REPLACES the first (old one closed): the likely
 *   cause is a client reconnect whose dead socket we haven't noticed yet,
 *   and the spec forbids duplicating messages across streams.
 * - Idle sessions are evicted after `idleTtlMs` (sweeper on an unref'ed
 *   timer), EXCEPT sessions holding an open GET stream — those are live by
 *   definition (the heartbeat keeps the socket warm). A request in flight
 *   when its session dies (TTL, DELETE, shutdown) answers 404 — matrix §1.5:
 *   a terminated session answers 404 from that point on.
 */

// Contracts live in session-support.ts (file-size split); public surface stays here.
export {
  SessionTornDownError,
  type DetectInitialize,
  type ExpectsResponse,
  type OpenedSession,
  type OpenSession,
  type OpenSessionRefusal,
  type ResponsePlan,
  type SessionContext,
  type SessionManager,
  type SessionManagerOptions,
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
  buffered: Buffer[]
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
  const uuid = opts.uuid ?? randomUUID
  const now = opts.now ?? Date.now

  const sessions = new Map<string, ActiveSession>()
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

  /** Routes one server-origin message: in-flight response > GET stream > bounded buffer. */
  function routeServerPayload(session: ActiveSession, payload: Buffer): void {
    if (session.inFlight !== null) {
      const pending = session.inFlight
      session.inFlight = null
      session.lastActivityMs = now()
      pending.resolve(payload)
      return
    }
    if (session.stream !== null && session.stream.isOpen()) {
      session.stream.send(payload)
      return
    }
    if (session.buffered.length >= maxBuffered) {
      session.buffered = session.buffered.slice(1)
    }
    session.buffered = [...session.buffered, payload]
  }

  async function teardownSession(session: ActiveSession): Promise<void> {
    if (!sessions.has(session.id)) {
      return
    }
    sessions.delete(session.id)
    session.inFlight?.reject(new SessionTornDownError())
    session.inFlight = null
    session.stream?.close()
    session.stream = null
    session.handle.source.dispose()
    try {
      await session.handle.close()
    } catch {
      opts.onSessionError?.(session.id)
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
      buffered: [],
      stream: null,
    }
    sessions.set(session.id, session)
    handle.source.onMessage((message) => routeServerPayload(session, message.bytes))
    handle.source.onError(() => opts.onSessionError?.(session.id))
    handle.source.onEnd(() => void teardownSession(session))
    return session
  }

  /** Writes `body` into the session and answers with the session's next message. */
  async function exchange(session: ActiveSession, body: Buffer): Promise<ResponsePlan> {
    if (!expectsResponse(body)) {
      await session.handle.sink.write(clientMessage(body))
      return Object.freeze({ status: HTTP_STATUS_ACCEPTED })
    }
    const pending = createDeferred<Buffer>()
    session.inFlight = pending
    try {
      await session.handle.sink.write(clientMessage(body))
      const payload = await pending.promise
      return jsonPlan(HTTP_STATUS_OK, payload)
    } catch (error: unknown) {
      if (session.inFlight === pending) {
        session.inFlight = null
      }
      if (error instanceof SessionTornDownError) {
        return jsonPlan(HTTP_STATUS_NOT_FOUND, BODY_SESSION_NOT_FOUND)
      }
      throw error
    }
  }

  async function handleSessionPost(session: ActiveSession, body: Buffer): Promise<ResponsePlan> {
    if (session.inFlight !== null) {
      return jsonPlan(HTTP_STATUS_CONFLICT, BODY_REQUEST_IN_FLIGHT)
    }
    session.lastActivityMs = now()
    return exchange(session, body)
  }

  async function handleInitializePost(ctx: SessionContext, body: Buffer): Promise<ResponsePlan> {
    if (sessions.size >= maxSessions) {
      return jsonPlan(HTTP_STATUS_TOO_MANY_REQUESTS, BODY_TOO_MANY_SESSIONS)
    }
    const opened = await opts.openSession(ctx)
    if ('error' in opened) {
      return refusalPlan(opened)
    }
    const session = registerSession(ctx, opened)
    let plan: ResponsePlan
    try {
      plan = await exchange(session, body)
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

  async function handleStatelessPost(
    ctx: SessionContext,
    headers: IncomingHttpHeaders,
    body: Buffer,
  ): Promise<ResponsePlan> {
    const validation = validateStatelessHeaders(headers, body)
    if (!validation.ok) {
      return jsonPlan(HTTP_STATUS_BAD_REQUEST, validation.errorBody)
    }
    const opened = await opts.openSession(ctx)
    if ('error' in opened) {
      return refusalPlan(opened)
    }
    try {
      if (!expectsResponse(body)) {
        await opened.sink.write(clientMessage(body))
        return Object.freeze({ status: HTTP_STATUS_ACCEPTED })
      }
      const first = createDeferred<Buffer>()
      opened.source.onMessage((message) => first.resolve(message.bytes))
      opened.source.onError((error) => first.reject(error))
      await opened.sink.write(clientMessage(body))
      return jsonPlan(HTTP_STATUS_OK, await first.promise)
    } finally {
      opened.source.dispose()
      await opened.close().catch(() => undefined)
    }
  }

  async function handlePost(
    ctx: SessionContext,
    headers: IncomingHttpHeaders,
    body: Buffer,
  ): Promise<ResponsePlan> {
    const sessionId = sessionIdOf(headers)
    if (sessionId !== null) {
      const session = lookupSession(ctx, sessionId)
      if (session === undefined) {
        return jsonPlan(HTTP_STATUS_NOT_FOUND, BODY_SESSION_NOT_FOUND)
      }
      return handleSessionPost(session, body)
    }
    if (detectInitialize(body)) {
      return handleInitializePost(ctx, body)
    }
    return handleStatelessPost(ctx, headers, body)
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
    const backlog = session.buffered
    session.buffered = []
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
    await Promise.all([...sessions.values()].map((session) => teardownSession(session)))
  }

  return Object.freeze({
    handlePost,
    handleGet,
    handleDelete,
    activeSessionCount: () => sessions.size,
    close,
  })
}
