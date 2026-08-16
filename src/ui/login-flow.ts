import type { IncomingMessage } from 'node:http'
import type { AdminResolver, LoginRateLimiter, PenaltyGate, SessionManager } from './auth.js'
import { loginRateLimitKey, serializeSessionCookie } from './auth.js'
import {
  BODY_TOO_MANY_REQUESTS,
  BODY_UNAUTHORIZED,
  CONTENT_TYPE_JSON,
  HTTP_STATUS_SEE_OTHER,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_UNAUTHORIZED,
  LOGIN_GLOBAL_PENALTY_WARNING,
  LOGIN_RATE_LIMIT_WARNING,
  POST_LOGIN_LOCATION,
  SESSION_CAPACITY_WARNING,
} from './constants.js'
import { headerValue, parseBodyFields, type UiRequestContext, type UiResult } from './routes.js'

/**
 * `POST /login` — the one request that turns an admin token into a session.
 * It lives beside the server rather than inside it because it is the only
 * place where four different concerns meet (rate limiting, token verification,
 * session minting and cookie shape), and because keeping it separate keeps
 * `server.ts` about routing.
 *
 * Two properties are load-bearing:
 *
 *  - **No oracle.** A missing token, a malformed one, an unknown one and a
 *    revoked one all produce the same byte-identical 401. Rate-limit refusals
 *    and session-cap refusals are likewise indistinguishable 429s.
 *  - **A redirect, not a document.** Success answers `303 See Other` → `/`
 *    with the `Set-Cookie`, so the plain, script-free `<form>` in
 *    `pages/login.ts` lands on a page instead of a JSON blob. The per-session
 *    CSRF token is deliberately NOT in this response: it travels in the
 *    destination page's `<meta name="csrf-token">`, keeping it out of the
 *    browser's history.
 */

/** Diagnostics sink (stderr-shaped), injectable for tests. */
export interface LoginWarnSink {
  write(chunk: string): unknown
}

export interface LoginFlowDeps {
  readonly adminStore: AdminResolver
  readonly sessions: SessionManager
  readonly rateLimiter: LoginRateLimiter
  /** Adds `Secure` to the session cookie (TLS terminated in front). */
  readonly behindTls: boolean
  readonly stderr: LoginWarnSink
  /**
   * Opt-in header the rate-limit key is read from when a reverse proxy is in
   * front (`--trusted-proxy-header`). Absent — the peer address is used.
   */
  readonly trustedProxyHeader?: string
  /** Sleep used to pay the global-ceiling penalty; injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>
  /**
   * Bounds how many attempts wait out the penalty at once. Absent, every
   * attempt pays it — see `createPenaltyGate` for why that is not free.
   */
  readonly penaltyGate?: PenaltyGate
}

/** Default penalty sleep. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

/** A JSON refusal body with the uniform content type. */
function refusal(status: number, body: Buffer): UiResult {
  return { kind: 'response', status, headers: { 'content-type': CONTENT_TYPE_JSON }, body }
}

/** Handles one `POST /login`, returning the plan for the server to write. */
export async function handleLoginRequest(
  deps: LoginFlowDeps,
  ctx: UiRequestContext,
  req: IncomingMessage,
): Promise<UiResult> {
  const key = loginRateLimitKey(req, deps.trustedProxyHeader)
  // The global ceiling slows every attempt down instead of refusing any: an
  // unkeyed refusal is a lockout primitive for anyone who can reach `/login`.
  const penalty = deps.rateLimiter.penaltyMs(key)
  // Past the concurrency bound the delay is SKIPPED, not turned into a refusal:
  // a held request is a held socket, and the throttle must never cost us more
  // than it costs the flood. Skipping degrades to the pre-penalty behaviour.
  if (penalty > 0 && (deps.penaltyGate === undefined || deps.penaltyGate.acquire())) {
    deps.stderr.write(`${LOGIN_GLOBAL_PENALTY_WARNING}\n`)
    try {
      await (deps.sleep ?? realSleep)(penalty)
    } finally {
      deps.penaltyGate?.release()
    }
  }
  if (!deps.rateLimiter.allow(key)) {
    deps.stderr.write(`${LOGIN_RATE_LIMIT_WARNING}\n`)
    return refusal(HTTP_STATUS_TOO_MANY_REQUESTS, BODY_TOO_MANY_REQUESTS)
  }
  const fields = parseBodyFields(ctx.body, headerValue(ctx.headers, 'content-type'))
  const token = fields.token
  const admin =
    token !== undefined && token !== '' ? await deps.adminStore.findAdminByToken(token) : undefined
  if (admin === undefined) {
    deps.rateLimiter.recordFailure(key)
    return refusal(HTTP_STATUS_UNAUTHORIZED, BODY_UNAUTHORIZED)
  }
  deps.rateLimiter.recordSuccess(key)
  const created = deps.sessions.create(admin)
  if (!created.ok) {
    // Caps are never met by evicting a live session, so a refusal is the honest
    // answer: the plane is holding as many sessions as it will hold.
    deps.stderr.write(`${SESSION_CAPACITY_WARNING} (${created.reason})\n`)
    return refusal(HTTP_STATUS_TOO_MANY_REQUESTS, BODY_TOO_MANY_REQUESTS)
  }
  return {
    kind: 'response',
    status: HTTP_STATUS_SEE_OTHER,
    headers: {
      location: POST_LOGIN_LOCATION,
      'set-cookie': serializeSessionCookie(created.sessionId, { secure: deps.behindTls }),
    },
  }
}
