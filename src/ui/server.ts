import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { isHostAllowed, isOriginAllowed, isWildcardBindHost, LOCALHOST_HOSTNAMES } from '../net/origin-host.js'
import type { AdminResolver, UiSession } from './auth.js'
import {
  clearSessionCookie,
  createLoginRateLimiter,
  createPenaltyGate,
  createSessionManager,
  parseSessionCookie,
  tokensEqual,
  type LoginRateLimiter,
  type SessionManager,
} from './auth.js'
import { authorize, matchRoute, type RouteEntry } from './authz.js'
import { handleLoginRequest } from './login-flow.js'
import {
  assertHandlersComplete,
  describeError,
  headerValue,
  parseBodyFields,
  parseTarget,
  readRequestBody,
  type StreamIdentity,
  type UiHandlers,
  type UiRequestContext,
  type UiResult,
} from './routes.js'
import { securityHeaders } from './security-headers.js'
import {
  BODY_FORBIDDEN,
  BODY_INTERNAL,
  BODY_NOT_IMPLEMENTED,
  BODY_PAYLOAD_TOO_LARGE,
  BODY_SESSION_EXPIRED,
  CONTENT_TYPE_HTML,
  CONTENT_TYPE_JSON,
  CSRF_FIELD_NAME,
  CSRF_HEADER_NAME,
  DEFAULT_UI_HOST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_FOUND,
  HTTP_STATUS_INTERNAL_ERROR,
  HTTP_STATUS_NOT_IMPLEMENTED,
  HTTP_STATUS_OK,
  HTTP_STATUS_PAYLOAD_TOO_LARGE,
  HTTP_STATUS_SEE_OTHER,
  HTTP_STATUS_UNAUTHORIZED,
  MAX_UI_BODY_BYTES,
  NON_LOCALHOST_BIND_WARNING,
  SCRIPT_REQUEST_HEADER,
  SCRIPT_REQUEST_VALUE,
  SSE_HEADERS,
  WILDCARD_BIND_WARNING,
} from './constants.js'

/**
 * Admin UI HTTP core (M4 Task 9). `node:http`, no framework; the same shape as
 * the agent front (`src/transport/http/server.ts`) but a different trust
 * domain — a human with a cookie session, not an agent with a Bearer token.
 *
 * Fixed request order, fail-closed at every step:
 *  1. Host not naming this listener → 403 (DNS rebinding; before anything).
 *  2. Origin present and not allowed → the same 403; and on a POST, Origin
 *     ABSENT is also a 403 (a browser always sends it on a state change).
 *  3. Route match against the normative `ROUTE_TABLE` (the outcome is not yet
 *     acted on — see 4, which must not depend on whether the path exists).
 *  4. Off the public surface: resolve+re-validate the presented session
 *     cookie. A cookie that no longer resolves → clear it and send the caller
 *     to `/login` (303, or 401 for the page script) — the ONE refusal that
 *     varies by credential state, and identical for a listed and an unlisted
 *     path so it stays no oracle. No cookie at all falls through unchanged.
 *  5. No route match → 403 (deny-by-default: an unlisted route is denied to
 *     everyone, no existence oracle).
 *  6. Public routes (`/login`, assets) dispatch straight away.
 *  7. Protected routes: authorize by role → CSRF-check state-changing POSTs →
 *     dispatch.
 *
 * Every response — page, asset, error, redirect, SSE — carries the security
 * headers (`security-headers.ts`). Handler failures collapse to a detail-free
 * 500; the stderr line carries only the error class and message.
 */

/** Stderr-like sink, injectable for tests. */
export interface WarnSink {
  write(chunk: string): unknown
}

export interface UiServerOptions {
  /** The admin store: login token resolution + per-request session freshness. */
  readonly adminStore: AdminResolver
  /** Injected page/action/SSE handlers keyed by `ROUTE_TABLE.handler`. */
  readonly handlers: UiHandlers
  /** Adds `Secure` to session cookies (TLS terminated in front). */
  readonly behindTls?: boolean
  /** Exact-match additions to the Host allowlist (e.g. a reverse-proxy name). */
  readonly allowedHosts?: readonly string[]
  /** Exact-match additions to the Origin allowlist. */
  readonly allowedOrigins?: readonly string[]
  /**
   * Header the login rate limit keys on instead of the peer address, for a
   * deployment behind a reverse proxy (`--trusted-proxy-header`). Off by
   * default: trusting it without a rewriting proxy in front lets any caller
   * pick its own bucket.
   */
  readonly trustedProxyHeader?: string
  readonly maxBodyBytes?: number
  /**
   * The session manager. Supply one when something outside the server holds
   * resources keyed on a session — the SSE hub subscribes to its drop events
   * and probes it on every heartbeat, which is what stops a live stream from
   * outliving the session that opened it. Omitted, the server builds its own.
   */
  readonly sessions?: SessionManager
  /** Session lifetime / cap overrides (tests). Ignored when `sessions` is given. */
  readonly sessionTtlMs?: number
  readonly maxSessions?: number
  /** Login rate-limit overrides (tests). */
  readonly loginMaxFailures?: number
  readonly loginWindowMs?: number
  /** Clock override (ms epoch) for deterministic TTL and rate windows. */
  readonly clock?: () => number
  /** Diagnostics sink; defaults to `process.stderr`. */
  readonly stderr?: WarnSink
}

export interface UiServer {
  /** Binds and resolves with the actual port (use 0 for an ephemeral one). */
  listen(port: number, host?: string): Promise<{ port: number }>
  /** Stops accepting and closes sockets. Idempotent. */
  close(): Promise<void>
  /** Live session count (tests). */
  sessionCount(): number
}

const EMPTY_BODY = Buffer.alloc(0)

/** Authenticated pages and errors must not sit in bfcache; assets set their own. */
const DEFAULT_CACHE_CONTROL = 'no-store'

export function createUiServer(opts: UiServerOptions): UiServer {
  assertHandlersComplete(opts.handlers)
  const stderr: WarnSink = opts.stderr ?? process.stderr
  const behindTls = opts.behindTls ?? false
  const allowedHosts = opts.allowedHosts ?? []
  const allowedOrigins = opts.allowedOrigins ?? []
  const maxBodyBytes = opts.maxBodyBytes ?? MAX_UI_BODY_BYTES
  const clock = opts.clock ?? (() => Date.now())
  const sessions: SessionManager =
    opts.sessions ??
    createSessionManager({
      clock,
      ...(opts.sessionTtlMs !== undefined ? { ttlMs: opts.sessionTtlMs } : {}),
      ...(opts.maxSessions !== undefined ? { maxSessions: opts.maxSessions } : {}),
    })
  // One gate per server: bounds how many logins sit in the global-ceiling
  // penalty at once, so the throttle cannot cost us more sockets than it costs
  // the flood it throttles.
  const penaltyGate = createPenaltyGate()
  const rateLimiter: LoginRateLimiter = createLoginRateLimiter({
    clock,
    ...(opts.loginMaxFailures !== undefined ? { maxFailures: opts.loginMaxFailures } : {}),
    ...(opts.loginWindowMs !== undefined ? { windowMs: opts.loginWindowMs } : {}),
  })

  let server: Server | null = null
  let closePromise: Promise<void> | null = null
  let bound: { readonly host: string; readonly port: number } | null = null

  // --- response writing ---------------------------------------------------

  function writeResult(res: ServerResponse, result: UiResult, identity?: StreamIdentity): void {
    if (result.kind === 'stream') {
      res.writeHead(HTTP_STATUS_OK, { ...SSE_HEADERS, ...securityHeaders({ behindTls }) })
      result.onStream(res, identity)
      return
    }
    // Security headers are spread LAST: a handler may pick its own content type
    // and cache policy (assets do), but must not be able to weaken the CSP,
    // nosniff, referrer or frame policy — accidentally or otherwise.
    const headers: Record<string, string> = {
      ...(result.headers ?? {}),
      ...securityHeaders({ behindTls }),
    }
    if (result.body !== undefined && headers['content-type'] === undefined) {
      headers['content-type'] =
        typeof result.body === 'string' ? CONTENT_TYPE_HTML : CONTENT_TYPE_JSON
    }
    // Default to `no-store` unless the handler set its own policy (assets keep
    // their `no-cache` + ETag): keeps authenticated pages out of the bfcache.
    if (headers['cache-control'] === undefined) headers['cache-control'] = DEFAULT_CACHE_CONTROL
    res.writeHead(result.status, headers)
    res.end(result.body)
  }

  function sendPlan(res: ServerResponse, status: number, body: Buffer): void {
    writeResult(res, { kind: 'response', status, headers: { 'content-type': CONTENT_TYPE_JSON }, body })
  }

  // --- request pipeline ---------------------------------------------------

  function buildContext(
    req: IncomingMessage,
    path: string,
    params: Readonly<Record<string, string>>,
    query: URLSearchParams,
    session: UiSession | undefined,
    body: Buffer,
  ): UiRequestContext {
    return {
      method: req.method ?? '',
      path,
      params,
      query,
      session,
      body,
      headers: req.headers as Readonly<Record<string, string | string[] | undefined>>,
    }
  }

  async function dispatchInjected(handlerKey: string, ctx: UiRequestContext): Promise<UiResult> {
    const handler = opts.handlers[handlerKey]
    if (handler === undefined) {
      return { kind: 'response', status: HTTP_STATUS_NOT_IMPLEMENTED, body: BODY_NOT_IMPLEMENTED }
    }
    return handler(ctx)
  }

  function csrfTokenOf(ctx: UiRequestContext): string | undefined {
    const headerToken = headerValue(ctx.headers, CSRF_HEADER_NAME)
    if (headerToken !== undefined) return headerToken
    const fields = parseBodyFields(ctx.body, headerValue(ctx.headers, 'content-type'))
    return fields[CSRF_FIELD_NAME]
  }

  function isCsrfValid(ctx: UiRequestContext, session: UiSession): boolean {
    const submitted = csrfTokenOf(ctx)
    if (submitted === undefined) return false
    return tokensEqual(submitted, session.csrfToken)
  }

  async function handleProtected(
    entry: RouteEntry,
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    params: Readonly<Record<string, string>>,
    query: URLSearchParams,
    body: Buffer,
    sessionId: string | undefined,
    session: UiSession | undefined,
  ): Promise<void> {
    const decision = authorize(entry, session)
    const identity: StreamIdentity | undefined =
      sessionId !== undefined && session !== undefined
        ? { sessionId, adminName: session.adminName }
        : undefined
    // No existence oracle: a missing session, an insufficient role and an
    // unlisted route all collapse to the SAME byte-identical 403. Redirecting
    // an anonymous GET to `/login` would let anyone enumerate real routes
    // (302 for a listed path vs 403 for an unlisted one). The login page is
    // still reachable directly at `GET /login` (public).
    if (decision.kind !== 'allow' || session === undefined) {
      // One exception to the uniform 403: an anonymous GET of the ROOT path is
      // sent to `/login`. `/` is not a secret — every visitor types it — so the
      // redirect leaks nothing, while a bare 403 on the landing page reads as
      // "the plane is broken" to an operator who simply is not signed in yet
      // (manual M4 smoke). The exception is exactly `/` and nothing else:
      // redirecting any other protected path would restore the enumeration
      // oracle (303 for a listed route vs 403 for an unlisted one).
      if (session === undefined && req.method === 'GET' && path === '/') {
        writeResult(res, {
          kind: 'response',
          status: HTTP_STATUS_SEE_OTHER,
          headers: { location: '/login' },
        })
        return
      }
      sendPlan(res, HTTP_STATUS_FORBIDDEN, BODY_FORBIDDEN)
      return
    }
    const ctx = buildContext(req, path, params, query, session, body)
    if (req.method === 'POST' && !isCsrfValid(ctx, session)) {
      sendPlan(res, HTTP_STATUS_FORBIDDEN, BODY_FORBIDDEN)
      return
    }
    if (entry.handler === '@logout') {
      sessions.destroy(sessionId)
      writeResult(res, {
        kind: 'response',
        status: HTTP_STATUS_FOUND,
        headers: { location: '/login', 'set-cookie': clearSessionCookie({ secure: behindTls }) },
      })
      return
    }
    writeResult(res, await dispatchInjected(entry.handler, ctx), identity)
  }

  /**
   * The answer to a request whose session cookie no longer resolves — expired,
   * rotated, removed, demoted, or forged. The cookie is cleared (otherwise the
   * browser presents the corpse on every later request, including the ones the
   * login page makes) and the caller is pointed at `/login`.
   *
   * The split is by WHO ASKED, not by method. A navigation — a typed URL, a
   * link, and the sign-out `<form method="post">` in the shell, which is a real
   * form and not a scripted action — renders whatever comes back, so it gets
   * the redirect and the human lands on the sign-in screen. The page script
   * announces itself with `x-requested-with: fetch` and gets a 401 instead:
   * `fetch` FOLLOWS a redirect transparently, so a 303 would hand the script
   * the login document under a 200 and let a dead action report success it
   * never had.
   *
   * This is the only refusal that varies by credential state, and it is not an
   * existence oracle: the answer is the same for a listed and an unlisted
   * path, and a caller with NO cookie still gets the uniform 403 everywhere.
   */
  function sendSessionExpired(req: IncomingMessage, res: ServerResponse): void {
    const setCookie = clearSessionCookie({ secure: behindTls })
    if (headerValue(req.headers, SCRIPT_REQUEST_HEADER) === SCRIPT_REQUEST_VALUE) {
      writeResult(res, {
        kind: 'response',
        status: HTTP_STATUS_UNAUTHORIZED,
        headers: { 'content-type': CONTENT_TYPE_JSON, 'set-cookie': setCookie },
        body: BODY_SESSION_EXPIRED,
      })
      return
    }
    writeResult(res, {
      kind: 'response',
      status: HTTP_STATUS_SEE_OTHER,
      headers: { location: '/login', 'set-cookie': setCookie },
    })
  }

  /** What the request's cookie turned out to be worth. */
  interface PresentedSession {
    /** The id the browser sent, or `undefined` when it sent none. */
    readonly sessionId: string | undefined
    /** The live session behind that id; `undefined` with an id present = dead. */
    readonly session: UiSession | undefined
  }

  /**
   * Resolves the cookie a request presents, ONCE per request and before the
   * route's existence is allowed to matter — so a dead session is answered the
   * same way whatever it was pointed at. The public surface is exempt: the
   * browser attaches the same dead cookie to the stylesheet and script
   * requests the login page itself makes, and redirecting those would strip
   * the sign-in screen of its own assets.
   */
  async function presentedSession(
    req: IncomingMessage,
    isPublicRoute: boolean,
  ): Promise<PresentedSession> {
    if (isPublicRoute) return { sessionId: undefined, session: undefined }
    const sessionId = parseSessionCookie(headerValue(req.headers, 'cookie'), { secure: behindTls })
    if (sessionId === undefined) return { sessionId: undefined, session: undefined }
    return { sessionId, session: await sessions.resolve(sessionId, opts.adminStore) }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = parseTarget(req.url)
    const match = matchRoute(req.method ?? '', parsed.path)
    const isPublicRoute = match !== null && match.entry.minRole === 'public'
    const { sessionId, session } = await presentedSession(req, isPublicRoute)
    if (sessionId !== undefined && session === undefined) {
      sendSessionExpired(req, res)
      return
    }
    if (match === null) {
      // Deny-by-default: unlisted route → 403 for everyone (no existence oracle).
      sendPlan(res, HTTP_STATUS_FORBIDDEN, BODY_FORBIDDEN)
      return
    }
    let body: Buffer = EMPTY_BODY
    if (req.method === 'POST') {
      const bodyResult = await readRequestBody(req, maxBodyBytes)
      if (!bodyResult.ok) {
        sendPlan(res, HTTP_STATUS_PAYLOAD_TOO_LARGE, BODY_PAYLOAD_TOO_LARGE)
        res.destroy()
        return
      }
      body = bodyResult.body
    }
    const { entry, params } = match
    if (isPublicRoute) {
      if (entry.handler === '@login') {
        const loginCtx = buildContext(req, parsed.path, params, parsed.query, undefined, body)
        writeResult(
          res,
          await handleLoginRequest(
            {
              adminStore: opts.adminStore,
              sessions,
              rateLimiter,
              penaltyGate,
              behindTls,
              stderr,
              ...(opts.trustedProxyHeader !== undefined
                ? { trustedProxyHeader: opts.trustedProxyHeader }
                : {}),
            },
            loginCtx,
            req,
          ),
        )
        return
      }
      const ctx = buildContext(req, parsed.path, params, parsed.query, undefined, body)
      writeResult(res, await dispatchInjected(entry.handler, ctx))
      return
    }
    await handleProtected(entry, req, res, parsed.path, params, parsed.query, body, sessionId, session)
  }

  function isRequestHostAllowed(req: IncomingMessage): boolean {
    if (bound === null) return false
    return isHostAllowed(headerValue(req.headers, 'host'), {
      boundHost: bound.host,
      port: bound.port,
      extraAllowed: allowedHosts,
    })
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isRequestHostAllowed(req)) {
      sendPlan(res, HTTP_STATUS_FORBIDDEN, BODY_FORBIDDEN)
      return
    }
    const origin = headerValue(req.headers, 'origin')
    if (!isOriginAllowed(origin, allowedOrigins)) {
      sendPlan(res, HTTP_STATUS_FORBIDDEN, BODY_FORBIDDEN)
      return
    }
    // A browser always attaches Origin to a POST, so a state-changing request
    // without one did not come from a page of this UI. Requiring it turns the
    // CSRF story from "SameSite + double-submit token" into a third
    // independent check, and costs nothing a real browser does. Reads are
    // deliberately exempt: typing the URL into the address bar sends no Origin,
    // and requiring one there would break the UI without removing any option
    // from an attacker.
    if (req.method === 'POST' && origin === undefined) {
      sendPlan(res, HTTP_STATUS_FORBIDDEN, BODY_FORBIDDEN)
      return
    }
    await route(req, res)
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((error: unknown) => {
      stderr.write(`[ui] request handler failed: ${describeError(error)}\n`)
      if (!res.headersSent) {
        sendPlan(res, HTTP_STATUS_INTERNAL_ERROR, BODY_INTERNAL)
      } else {
        res.destroy()
      }
    })
  }

  function listen(port: number, host?: string): Promise<{ port: number }> {
    const bindHost = host ?? DEFAULT_UI_HOST
    if (!LOCALHOST_HOSTNAMES.includes(bindHost)) {
      stderr.write(`${NON_LOCALHOST_BIND_WARNING}\n`)
      if (isWildcardBindHost(bindHost)) stderr.write(`${WILDCARD_BIND_WARNING}\n`)
    }
    return new Promise((resolve, reject) => {
      const instance = createServer(onRequest)
      server = instance
      instance.once('error', reject)
      instance.listen(port, bindHost, () => {
        instance.removeListener('error', reject)
        const address = instance.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('ui server: listener has no TCP address'))
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
    bound = null
    if (instance === null) return
    const closed = new Promise<void>((resolve, reject) => {
      instance.close((error) => (error ? reject(error) : resolve()))
    })
    instance.closeIdleConnections()
    instance.closeAllConnections()
    await closed
  }

  function close(): Promise<void> {
    closePromise ??= doClose()
    return closePromise
  }

  return Object.freeze({ listen, close, sessionCount: () => sessions.size() })
}

