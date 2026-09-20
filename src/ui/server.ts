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
} from '../net/connection-timeouts.js'
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
import { CONSOLE_API_PREFIX } from '../console-api/contract.js'
import type { ConsoleRunner } from '../console-api/runner.js'
import { authorize, matchRoute, type RouteEntry } from './authz.js'
import { createConsoleApiRoutes, type ConsoleApiRouter } from './console-api.js'
import { createCorePublicRoutes } from './core-public.js'
import type { LoginFlowDeps } from './login-flow.js'
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
import type { FirstRunOptions } from './setup-flow.js'
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
  LOGIN_LOCATION,
  MAX_UI_BODY_BYTES,
  NON_LOCALHOST_BIND_WARNING,
  SCRIPT_REQUEST_HEADER,
  SCRIPT_REQUEST_VALUE,
  SSE_HEADERS,
  UI_HEADERS_TIMEOUT_MS,
  UI_KEEP_ALIVE_TIMEOUT_MS,
  UI_REQUEST_TIMEOUT_MS,
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
 *     cookie. NOT SIGNED IN — no cookie, or one that no longer resolves (then
 *     it is cleared) — → `/login` (303, or 401 for the page script),
 *     identical for a listed and an unlisted path so it is no oracle. While
 *     the install has NO admin the 303 names `/setup` instead (first run,
 *     `setup-flow.ts`): nobody holds a token the sign-in screen could take.
 *  5. No route match → 403 for a signed-in caller (deny-by-default: an
 *     unlisted route is denied to everyone).
 *  6. Public routes (`/login`, `/setup`, assets) dispatch straight away.
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
  /** Runs after each successful login (`LoginFlowDeps.afterSignIn`); its failure never changes the answer. */
  readonly afterSignIn?: LoginFlowDeps['afterSignIn']
  /**
   * Makes `/setup` exist (`setup-flow.ts`): while its gate is open, a caller
   * who is not signed in is sent there instead of to a sign-in screen nobody
   * holds a token for. Absent — `/setup` answers `/login`, as if closed.
   */
  readonly firstRun?: FirstRunOptions
  /**
   * Enables `/api/console/*` (ADR-0014, wave 1): the injected runner IS the
   * remote console API, on this same port. `server.ts` branches to it before
   * the cookie-based pipeline even parses a session — no cookie is read and
   * an `Origin` header refuses the request outright, on every method.
   * Absent (every UI test that predates this feature, and any deployment that
   * never wants a remote console), `/api/console/*` falls through unbranched
   * and is answered exactly as any other unlisted route is today.
   */
  readonly consoleRunner?: ConsoleRunner
}

/** The per-connection timeouts a live listener enforces, read back from it (tests). */
export interface UiServer {
  /** Binds and resolves with the actual port (use 0 for an ephemeral one). */
  listen(port: number, host?: string): Promise<{ port: number }>
  /** Stops accepting and closes sockets. Idempotent. */
  close(): Promise<void>
  /** Live session count (tests). */
  sessionCount(): number
  /** Timeouts of the live listener; `null` before `listen` (tests). */
  connectionTimeouts(): ConnectionTimeouts | null
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

  // The login and first-run flows share one limiter on purpose: `/setup` is
  // not a second budget of attempts for the same address.
  const corePublic = createCorePublicRoutes({
    login: {
      adminStore: opts.adminStore,
      sessions,
      rateLimiter,
      penaltyGate,
      behindTls,
      stderr,
      ...(opts.trustedProxyHeader !== undefined ? { trustedProxyHeader: opts.trustedProxyHeader } : {}),
      ...(opts.afterSignIn !== undefined ? { afterSignIn: opts.afterSignIn } : {}),
    },
    ...(opts.firstRun !== undefined ? { firstRun: opts.firstRun } : {}),
  })

  // The remote console API (ADR-0014, wave 1): built only when a runner is
  // injected, sharing this server's own admin store, rate limiter and
  // first-run options — one shared limiter is what keeps `/api/console/setup`
  // from being a second budget beside `/login` and `/setup`.
  const consoleApi: ConsoleApiRouter | undefined =
    opts.consoleRunner === undefined
      ? undefined
      : createConsoleApiRoutes({
          adminStore: opts.adminStore,
          rateLimiter,
          penaltyGate,
          ...(opts.trustedProxyHeader !== undefined ? { trustedProxyHeader: opts.trustedProxyHeader } : {}),
          ...(opts.firstRun !== undefined ? { firstRun: opts.firstRun } : {}),
          runner: opts.consoleRunner,
          behindTls,
          maxBodyBytes,
          stderr,
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
    // Not signed in → the sign-in screen, whatever was asked for (`sendToLogin`
    // explains the shape). Signed in but short of the role → the uniform 403,
    // byte-identical to an unlisted route: the two must stay indistinguishable,
    // or a viewer could enumerate the owner-only surface.
    if (session === undefined) {
      await sendToLogin(req, res, false)
      return
    }
    if (decision.kind !== 'allow') {
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
        headers: { location: LOGIN_LOCATION, 'set-cookie': clearSessionCookie({ secure: behindTls }) },
      })
      return
    }
    writeResult(res, await dispatchInjected(entry.handler, ctx), identity)
  }

  /**
   * The answer to a request that is NOT SIGNED IN: either it presented a
   * session cookie that no longer resolves (expired, rotated, removed,
   * demoted, forged — then the cookie is cleared, otherwise the browser
   * presents the corpse on every later request, including the ones the login
   * page makes), or it presented none at all. Both are pointed at `/login`:
   * the bare `{"error":"forbidden"}` blob a browser window used to render
   * reads as "the plane is broken" to someone who is simply signed out — the
   * complaint the M4 smoke raised about the landing page, which every other
   * page shared until the answer stopped depending on the path.
   *
   * The split is by WHO ASKED, not by method. A navigation — a typed URL, a
   * link, a bookmark, and the sign-out `<form method="post">` in the shell,
   * which is a real form and not a scripted action — renders whatever comes
   * back, so it gets the redirect and the human lands on the sign-in screen.
   * The page script announces itself with `x-requested-with: fetch` and gets a
   * 401 instead: `fetch` FOLLOWS a redirect transparently, so a 303 would hand
   * the script the login document under a 200 and let a dead action report
   * success it never had.
   *
   * No existence oracle: the answer does not depend on whether the path is in
   * the route table — an unlisted path answers exactly the same — so it says
   * only "you are not signed in", which the caller already knew. What stays
   * uniform is the refusal that DOES depend on the path's role: a signed-in
   * caller below the bar and an unlisted route are one byte-identical 403.
   */
  async function sendToLogin(req: IncomingMessage, res: ServerResponse, hadCookie: boolean): Promise<void> {
    // Nothing to clear when no cookie was presented; sending the header anyway
    // would make the two cases distinguishable for no gain.
    const setCookie = hadCookie ? { 'set-cookie': clearSessionCookie({ secure: behindTls }) } : {}
    if (headerValue(req.headers, SCRIPT_REQUEST_HEADER) === SCRIPT_REQUEST_VALUE) {
      writeResult(res, {
        kind: 'response',
        status: HTTP_STATUS_UNAUTHORIZED,
        headers: { 'content-type': CONTENT_TYPE_JSON, ...setCookie },
        body: BODY_SESSION_EXPIRED,
      })
      return
    }
    writeResult(res, {
      kind: 'response',
      status: HTTP_STATUS_SEE_OTHER,
      headers: { location: await corePublic.signedOutLocation(), ...setCookie },
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
      await sendToLogin(req, res, true)
      return
    }
    if (match === null) {
      // Deny-by-default. A caller who is not signed in is sent to `/login` here
      // too — the answer must not turn on whether the path exists; for everyone
      // else an unlisted route is a 403, the same one an over-privileged path
      // gives (no existence oracle).
      if (session === undefined) {
        await sendToLogin(req, res, false)
        return
      }
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
      const ctx = buildContext(req, parsed.path, params, parsed.query, undefined, body)
      const core = await corePublic.handle(entry, ctx, req)
      writeResult(res, core ?? (await dispatchInjected(entry.handler, ctx)))
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
    // The remote console API is a DIFFERENT trust domain from the browser UI
    // below (Bearer, not cookie) and is branched to BEFORE the cookie-based
    // pipeline's own Origin rule and session resolution: it enforces its own,
    // stricter Origin rule (any Origin at all is refused, module doc) and
    // never reads a cookie. Host screening above still applies to it. Absent
    // `consoleRunner`, this branch is skipped and the prefix falls through
    // unchanged — an unlisted route, exactly as it answered before this
    // feature existed.
    if (consoleApi !== undefined && parseTarget(req.url).path.startsWith(CONSOLE_API_PREFIX)) {
      await consoleApi.handle(req, res)
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
      // Audit 2026-09-02, LOW-2 — the constants say what each timer does and does not cover.
      applyConnectionTimeouts(instance, {
        headersTimeoutMs: UI_HEADERS_TIMEOUT_MS,
        requestTimeoutMs: UI_REQUEST_TIMEOUT_MS,
        keepAliveTimeoutMs: UI_KEEP_ALIVE_TIMEOUT_MS,
      })
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

  return Object.freeze({
    listen,
    close,
    sessionCount: () => sessions.size(),
    connectionTimeouts: () => (server === null ? null : readConnectionTimeouts(server)),
  })
}

