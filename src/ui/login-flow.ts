import type { IncomingMessage } from 'node:http'
import type { AdminResolver, LoginRateLimiter, SessionManager } from './auth.js'
import { serializeSessionCookie } from './auth.js'
import {
  BODY_TOO_MANY_REQUESTS,
  BODY_UNAUTHORIZED,
  CONTENT_TYPE_JSON,
  HTTP_STATUS_SEE_OTHER,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_UNAUTHORIZED,
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
}

/** A JSON refusal body with the uniform content type. */
function refusal(status: number, body: Buffer): UiResult {
  return { kind: 'response', status, headers: { 'content-type': CONTENT_TYPE_JSON }, body }
}

/**
 * Rate-limit key for a login attempt: the peer address. Keying the window per
 * client is what keeps one wrong-guessing machine from locking every admin out;
 * an unresolvable address collapses into one shared bucket, which is the
 * conservative side of the trade.
 */
export function loginRateLimitKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown'
}

/** Handles one `POST /login`, returning the plan for the server to write. */
export async function handleLoginRequest(
  deps: LoginFlowDeps,
  ctx: UiRequestContext,
  req: IncomingMessage,
): Promise<UiResult> {
  const key = loginRateLimitKey(req)
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
