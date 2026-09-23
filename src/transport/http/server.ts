import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import {
  applyConnectionTimeouts,
  readConnectionTimeouts,
  type ConnectionTimeouts,
} from '../../net/connection-timeouts.js'
import { isHostAllowed, isWildcardBindHost, LOCALHOST_HOSTNAMES } from '../../net/origin-host.js'
import { authenticate, type TokenResolver } from './auth.js'
import { isOriginAllowed, parseRoute, type RouteMethod } from './routes.js'
import {
  BODY_FORBIDDEN,
  BODY_INTERNAL,
  BODY_NOT_FOUND,
  BODY_PAYLOAD_TOO_LARGE,
  BODY_UNAUTHORIZED,
  DEFAULT_HTTP_HOST,
  HEADERS_TIMEOUT_MS,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_ERROR,
  HTTP_STATUS_PAYLOAD_TOO_LARGE,
  HTTP_STATUS_UNAUTHORIZED,
  KEEP_ALIVE_TIMEOUT_MS,
  MAX_REQUEST_BODY_BYTES,
  NON_LOCALHOST_BIND_WARNING,
  POOL_ROUTE_TARGET,
  REQUEST_TIMEOUT_MS,
  WILDCARD_BIND_WARNING,
} from './server-constants.js'
import { CONTENT_TYPE_JSON, HTTP_STATUS_NOT_FOUND } from './constants.js'
import {
  createSessionManager,
  type ResponsePlan,
  type SessionContext,
  type SessionManagerOptions,
} from './session.js'

/**
 * Downstream HTTP front (M3 Task 10): `node:http`, no framework, glueing
 * Origin screening → Bearer auth → route parsing → the dual-model session
 * manager (`session.ts`). Request processing order is deliberate:
 *
 * 1. Host not naming this listener → 403 before anything else (DNS
 *    rebinding defense — matrix §4.2; the refusal is byte-identical to the
 *    Origin one, so neither check is an oracle for the other).
 * 2. Origin present and not allowed → the same 403 (spec MUST).
 * 3. Authentication → uniform 401 (`auth.ts`) — BEFORE any route
 *    existence answer, so the name space cannot be scanned without a token.
 * 4. Route parse; no match, or a PER-SERVER path naming a different agent
 *    than the token resolved to → 404 (a valid token buys visibility into
 *    exactly one agent's namespace, nobody else's). The pool path carries no
 *    agent segment — the token alone names the agent (PE5) — so there is
 *    nothing to compare, and the union makes that a type-level fact rather
 *    than a rule to remember.
 * 5. Dispatch to the session manager.
 *
 * The pool route sits AFTER authentication like every other: an
 * unauthenticated `GET /mcp` gets the same 401 as any path, so the endpoint's
 * existence is never an oracle.
 *
 * Handler failures are caught: the response is a detail-free 500
 * `{"error":"internal"}` and the stderr line carries the error's class and
 * message only — never request bodies, headers or tokens.
 */

/** Stderr-like sink, injectable for tests. */
export interface WarnSink {
  write(chunk: string): unknown
}

export interface HttpFrontOptions extends Omit<SessionManagerOptions, 'onSessionError'> {
  readonly agentsStore: TokenResolver
  /** Exact-match additions to the localhost Origin allowlist. */
  readonly allowedOrigins?: readonly string[]
  /** Exact-match additions to the Host allowlist (e.g. a reverse-proxy name). */
  readonly allowedHosts?: readonly string[]
  readonly maxBodyBytes?: number
  /** Diagnostics sink; defaults to `process.stderr`. */
  readonly stderr?: WarnSink
}

/** The per-connection timeouts a live listener enforces, read back from it (tests). */
export interface HttpFront {
  /** Binds and resolves with the actual port (use 0 for an ephemeral one). */
  listen(port: number, host?: string): Promise<{ port: number }>
  /** Stops accepting, tears down every session, closes remaining sockets. Idempotent. */
  close(): Promise<void>
  /** Timeouts of the live listener; `null` before `listen` (tests). */
  connectionTimeouts(): ConnectionTimeouts | null
  /**
   * Sessions occupying a slot right now: registered ones, opens in flight, and
   * whatever `extraSessions` declares (a pool's children). Read by the pool
   * factory so a pool that grows AFTER its own admission still respects the
   * process-wide ceiling (plan decision P5).
   */
  activeSessionCount(): number
}

/** Body read outcome: the whole payload or an over-limit refusal. */
type BodyResult = { readonly ok: true; readonly body: Buffer } | { readonly ok: false }

/** Buffers a request body, refusing past `maxBytes` (→ 413). */
function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        req.removeAllListeners('data')
        req.removeAllListeners('end')
        resolve({ ok: false })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve({ ok: true, body: Buffer.concat(chunks) }))
    req.on('error', (error: unknown) => reject(error))
  })
}

function writePlan(res: ServerResponse, plan: ResponsePlan): void {
  const headers: Record<string, string> = { ...plan.headers }
  if (plan.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = CONTENT_TYPE_JSON
  }
  res.writeHead(plan.status, headers)
  res.end(plan.body)
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  return Array.isArray(raw) ? raw[0] : raw
}

/** Class and message only — never a body, a header or a token. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Fires when the socket dies before the answer was written. The session
 * manager uses it to stop waiting on an upstream nobody will read anymore
 * (an agent that gave up must not keep a child process alive).
 */
function abortSignalOf(res: ServerResponse): AbortSignal {
  const controller = new AbortController()
  res.once('close', () => {
    if (!res.writableEnded) {
      controller.abort()
    }
  })
  return controller.signal
}

export function createHttpFront(opts: HttpFrontOptions): HttpFront {
  const stderr: WarnSink = opts.stderr ?? process.stderr
  const allowedOrigins = opts.allowedOrigins ?? []
  const allowedHosts = opts.allowedHosts ?? []
  const maxBodyBytes = opts.maxBodyBytes ?? MAX_REQUEST_BODY_BYTES
  const manager = createSessionManager({
    ...opts,
    onSessionError: (sessionId, error) => {
      stderr.write(`[http] session ${sessionId}: ${describeError(error)}\n`)
    },
  })

  let server: Server | null = null
  let closePromise: Promise<void> | null = null
  /** The listening endpoint; requests are refused until `listen` records it (fail closed). */
  let bound: { readonly host: string; readonly port: number } | null = null

  async function dispatch(
    method: RouteMethod,
    ctx: SessionContext,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (method === 'GET') {
      const outcome = manager.handleGet(ctx, req.headers, res)
      if (outcome !== 'attached') {
        writePlan(res, outcome)
      }
      return
    }
    if (method === 'DELETE') {
      writePlan(res, await manager.handleDelete(ctx, req.headers))
      return
    }
    const signal = abortSignalOf(res)
    const bodyResult = await readRequestBody(req, maxBodyBytes)
    if (!bodyResult.ok) {
      writePlan(res, {
        status: HTTP_STATUS_PAYLOAD_TOO_LARGE,
        body: BODY_PAYLOAD_TOO_LARGE,
      })
      // The rest of the oversized body is unread; drop the connection.
      res.destroy()
      return
    }
    const plan = await manager.handlePost(ctx, req.headers, bodyResult.body, { signal })
    if (res.writableEnded || res.destroyed) {
      // The agent hung up while its answer was being produced.
      return
    }
    writePlan(res, plan)
  }

  /** Host screening against the recorded listening endpoint (step 1). */
  function isRequestHostAllowed(req: IncomingMessage): boolean {
    if (bound === null) {
      return false
    }
    return isHostAllowed(headerValue(req, 'host'), {
      boundHost: bound.host,
      port: bound.port,
      extraAllowed: allowedHosts,
    })
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isRequestHostAllowed(req)) {
      writePlan(res, { status: HTTP_STATUS_FORBIDDEN, body: BODY_FORBIDDEN })
      return
    }
    if (!isOriginAllowed(headerValue(req, 'origin'), allowedOrigins)) {
      writePlan(res, { status: HTTP_STATUS_FORBIDDEN, body: BODY_FORBIDDEN })
      return
    }
    const auth = await authenticate(headerValue(req, 'authorization'), opts.agentsStore)
    if (!auth.ok) {
      writePlan(res, { status: HTTP_STATUS_UNAUTHORIZED, body: BODY_UNAUTHORIZED })
      return
    }
    const route = parseRoute(req.method, req.url)
    if (route === null || (route.kind === 'server' && route.agentName !== auth.agent.name)) {
      writePlan(res, { status: HTTP_STATUS_NOT_FOUND, body: BODY_NOT_FOUND })
      return
    }
    const ctx: SessionContext =
      route.kind === 'pool'
        ? { agentName: auth.agent.name, serverName: POOL_ROUTE_TARGET }
        : { agentName: route.agentName, serverName: route.serverName }
    await dispatch(route.method, ctx, req, res)
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((error: unknown) => {
      const label = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      stderr.write(`[http] request handler failed: ${label}\n`)
      if (!res.headersSent) {
        writePlan(res, { status: HTTP_STATUS_INTERNAL_ERROR, body: BODY_INTERNAL })
      } else {
        res.destroy()
      }
    })
  }

  function listen(port: number, host?: string): Promise<{ port: number }> {
    const bindHost = host ?? DEFAULT_HTTP_HOST
    if (!LOCALHOST_HOSTNAMES.includes(bindHost)) {
      stderr.write(`${NON_LOCALHOST_BIND_WARNING}\n`)
      if (isWildcardBindHost(bindHost)) {
        stderr.write(`${WILDCARD_BIND_WARNING}\n`)
      }
    }
    return new Promise((resolve, reject) => {
      const instance = createServer(onRequest)
      // Audit 2026-09-02, F3 — the constants say what each timer does and does not cover.
      applyConnectionTimeouts(instance, {
        headersTimeoutMs: HEADERS_TIMEOUT_MS,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        keepAliveTimeoutMs: KEEP_ALIVE_TIMEOUT_MS,
      })
      server = instance
      instance.once('error', reject)
      instance.listen(port, bindHost, () => {
        instance.removeListener('error', reject)
        const address = instance.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('http front: listener has no TCP address'))
          return
        }
        bound = Object.freeze({ host: bindHost, port: address.port })
        resolve({ port: address.port })
      })
    })
  }

  async function doClose(): Promise<void> {
    const instance = server
    server = null
    // Back to the pre-listen state: any straggler request racing the close is
    // refused by the fail-closed Host check rather than screened against an
    // endpoint that no longer exists.
    bound = null
    if (instance === null) {
      await manager.close()
      return
    }
    const closed = new Promise<void>((resolve, reject) => {
      instance.close((error) => (error ? reject(error) : resolve()))
    })
    // Session teardown ends the SSE responses, freeing their sockets; any
    // remaining keep-alive sockets are then severed so `close` cannot hang.
    await manager.close()
    instance.closeIdleConnections()
    instance.closeAllConnections()
    await closed
  }

  function close(): Promise<void> {
    closePromise ??= doClose()
    return closePromise
  }

  return Object.freeze({
    listen,
    close,
    connectionTimeouts: () => (server === null ? null : readConnectionTimeouts(server)),
    activeSessionCount: manager.activeSessionCount,
  })
}
