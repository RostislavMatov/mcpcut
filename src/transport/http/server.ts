import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { authenticate, type TokenResolver } from './auth.js'
import { isOriginAllowed, parseRoute, type RouteMatch } from './routes.js'
import {
  BODY_FORBIDDEN,
  BODY_INTERNAL,
  BODY_NOT_FOUND,
  BODY_PAYLOAD_TOO_LARGE,
  BODY_UNAUTHORIZED,
  DEFAULT_HTTP_HOST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_ERROR,
  HTTP_STATUS_PAYLOAD_TOO_LARGE,
  HTTP_STATUS_UNAUTHORIZED,
  LOCALHOST_HOSTNAMES,
  MAX_REQUEST_BODY_BYTES,
  NON_LOCALHOST_BIND_WARNING,
} from './server-constants.js'
import { CONTENT_TYPE_JSON, HTTP_STATUS_NOT_FOUND } from './constants.js'
import {
  createSessionManager,
  type ResponsePlan,
  type SessionManagerOptions,
} from './session.js'

/**
 * Downstream HTTP front (M3 Task 10): `node:http`, no framework, glueing
 * Origin screening → Bearer auth → route parsing → the dual-model session
 * manager (`session.ts`). Request processing order is deliberate:
 *
 * 1. Origin present and not allowed → 403 before anything else (spec MUST;
 *    DNS rebinding defense — matrix §4.2).
 * 2. Authentication → uniform 401 (`auth.ts`) — BEFORE any route
 *    existence answer, so the name space cannot be scanned without a token.
 * 3. Route parse; no match, or a path naming a DIFFERENT agent than the
 *    token resolved to → 404 (a valid token buys visibility into exactly
 *    one agent's namespace, nobody else's).
 * 4. Dispatch to the session manager.
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
  readonly maxBodyBytes?: number
  /** Diagnostics sink; defaults to `process.stderr`. */
  readonly stderr?: WarnSink
}

export interface HttpFront {
  /** Binds and resolves with the actual port (use 0 for an ephemeral one). */
  listen(port: number, host?: string): Promise<{ port: number }>
  /** Stops accepting, tears down every session, closes remaining sockets. Idempotent. */
  close(): Promise<void>
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

export function createHttpFront(opts: HttpFrontOptions): HttpFront {
  const stderr: WarnSink = opts.stderr ?? process.stderr
  const allowedOrigins = opts.allowedOrigins ?? []
  const maxBodyBytes = opts.maxBodyBytes ?? MAX_REQUEST_BODY_BYTES
  const manager = createSessionManager({
    ...opts,
    onSessionError: (sessionId) => {
      stderr.write(`[http] session ${sessionId}: upstream error\n`)
    },
  })

  let server: Server | null = null
  let closePromise: Promise<void> | null = null

  async function dispatch(
    route: RouteMatch,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const ctx = { agentName: route.agentName, serverName: route.serverName }
    if (route.method === 'GET') {
      const outcome = manager.handleGet(ctx, req.headers, res)
      if (outcome !== 'attached') {
        writePlan(res, outcome)
      }
      return
    }
    if (route.method === 'DELETE') {
      writePlan(res, await manager.handleDelete(ctx, req.headers))
      return
    }
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
    writePlan(res, await manager.handlePost(ctx, req.headers, bodyResult.body))
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    if (route === null || route.agentName !== auth.agent.name) {
      writePlan(res, { status: HTTP_STATUS_NOT_FOUND, body: BODY_NOT_FOUND })
      return
    }
    await dispatch(route, req, res)
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
    }
    return new Promise((resolve, reject) => {
      const instance = createServer(onRequest)
      server = instance
      instance.once('error', reject)
      instance.listen(port, bindHost, () => {
        instance.removeListener('error', reject)
        const address = instance.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('http front: listener has no TCP address'))
          return
        }
        resolve({ port: address.port })
      })
    })
  }

  async function doClose(): Promise<void> {
    const instance = server
    server = null
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

  return Object.freeze({ listen, close })
}
