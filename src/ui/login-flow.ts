import type { IncomingMessage } from 'node:http'
import { UNKNOWN_TOKEN_NOTICE } from '../admin/constants.js'
import type { AdminRecord } from '../admin/store.js'
import { formatReadableField } from '../journal/format.js'
import type { AdminResolver, LoginRateLimiter, PenaltyGate, SessionManager } from './auth.js'
import { loginRateLimitKey, serializeSessionCookie } from './auth.js'
import {
  BODY_TOO_MANY_REQUESTS,
  BODY_UNAUTHORIZED,
  CONTENT_TYPE_HTML,
  CONTENT_TYPE_JSON,
  HTML_MEDIA_TYPE,
  HTTP_STATUS_SEE_OTHER,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_UNAUTHORIZED,
  LOGIN_GLOBAL_PENALTY_WARNING,
  LOGIN_RATE_LIMIT_WARNING,
  POST_LOGIN_LOCATION,
  SCRIPT_REQUEST_HEADER,
  SCRIPT_REQUEST_VALUE,
  SESSION_CAPACITY_WARNING,
  TOO_MANY_ATTEMPTS_NOTICE,
} from './constants.js'
import { renderLoginPage } from './pages/login.js'
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
 *  - **The keyed decision is taken and recorded before anything awaits.**
 *    Nothing may sit between `allow(key)` and the attempt being counted — not
 *    the penalty delay, not the token lookup. Whatever does, every attempt
 *    parked in that gap wakes to a window that still looks empty, and one
 *    address's 5-per-minute allowance becomes a burst of however many requests
 *    fit in the gap.
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
  /**
   * Runs once a session has been minted, with the admin who signed in (phase
   * 6, F6: removing a leftover setup code file). It is called AFTER
   * `sessions.create` and its failure is a stderr line, never a different
   * answer: the sign-in already happened, and the cookie the browser is about
   * to receive must not be withheld because a file on the host would not
   * unlink. It never runs for a refused login.
   */
  readonly afterSignIn?: (admin: AdminRecord) => Promise<void>
}

/**
 * What paying the global-ceiling delay needs. Its own shape since ADR-0014:
 * the console API's Bearer path (`console-auth.ts`) takes the same credential
 * `/login` does, so it pays the same delay through this one function.
 */
export type GlobalPenaltyDeps = Pick<LoginFlowDeps, 'stderr' | 'sleep' | 'penaltyGate'>

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

/**
 * True when this request is a BROWSER NAVIGATION — a person who pressed a
 * button on a page, not a script or a client that parses JSON.
 *
 * Two signals, both cheap and both only about the SHAPE of the answer, never
 * about whether it is allowed: an `Accept` that asks for HTML, and the absence
 * of the page script's own "a `fetch()` is asking" marker (the same header the
 * dead-session refusal already switches on). Forging either buys nothing.
 */
function wantsHtml(ctx: UiRequestContext): boolean {
  if (headerValue(ctx.headers, SCRIPT_REQUEST_HEADER) === SCRIPT_REQUEST_VALUE) return false
  return (headerValue(ctx.headers, 'accept') ?? '').includes(HTML_MEDIA_TYPE)
}

/**
 * The refused sign-in, in the shape its caller can use: for a browser the
 * `/login` page again, carrying the error and the form; for anything else the
 * byte-identical JSON body that has always been there (UX-1).
 *
 * The status and the NO-ORACLE property are untouched either way — the page is
 * rendered from one constant sentence, so a token that never existed, one that
 * was rotated and one whose admin is gone still produce byte-identical
 * documents. `no-store` and the security headers are added by the server core,
 * as on every other response.
 */
function refuseLogin(ctx: UiRequestContext, status: number, body: Buffer, error: string): UiResult {
  if (!wantsHtml(ctx)) return refusal(status, body)
  return {
    kind: 'response',
    status,
    headers: { 'content-type': CONTENT_TYPE_HTML },
    body: renderLoginPage({ error }),
  }
}

/**
 * Waits out the global-ceiling delay, if one is owed.
 *
 * Past the concurrency bound the delay is SKIPPED, not turned into a refusal:
 * a held request is a held socket, and the throttle must never cost us more
 * than it costs the flood. Skipping degrades to the pre-penalty behaviour.
 */
export async function payGlobalPenalty(deps: GlobalPenaltyDeps, penaltyMs: number): Promise<void> {
  if (penaltyMs <= 0) return
  if (deps.penaltyGate !== undefined && !deps.penaltyGate.acquire()) return
  deps.stderr.write(`${LOGIN_GLOBAL_PENALTY_WARNING}\n`)
  try {
    await (deps.sleep ?? realSleep)(penaltyMs)
  } finally {
    deps.penaltyGate?.release()
  }
}

/**
 * The post-sign-in hook, contained: whatever it throws becomes one
 * terminal-safe stderr line, and the caller goes on to answer exactly as it
 * would have without the hook.
 */
async function runAfterSignIn(deps: LoginFlowDeps, admin: AdminRecord): Promise<void> {
  if (deps.afterSignIn === undefined) return
  try {
    await deps.afterSignIn(admin)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    deps.stderr.write(`[ui] after sign-in: ${formatReadableField(message)}\n`)
  }
}

/** Handles one `POST /login`, returning the plan for the server to write. */
export async function handleLoginRequest(
  deps: LoginFlowDeps,
  ctx: UiRequestContext,
  req: IncomingMessage,
): Promise<UiResult> {
  const key = loginRateLimitKey(req, deps.trustedProxyHeader)
  const penalty = deps.rateLimiter.penaltyMs(key)
  // The keyed refusal comes first and is answered IMMEDIATELY: this address has
  // spent its allowance, and holding a caller we have already decided to refuse
  // buys nothing but a socket. It grants no guess, so answering it cheaply
  // hands an attacker nothing either.
  if (!deps.rateLimiter.allow(key)) {
    deps.stderr.write(`${LOGIN_RATE_LIMIT_WARNING}\n`)
    return refuseLogin(ctx, HTTP_STATUS_TOO_MANY_REQUESTS, BODY_TOO_MANY_REQUESTS, TOO_MANY_ATTEMPTS_NOTICE)
  }
  // Counted here, one statement after the check and before the first `await`,
  // so concurrent attempts on this key cannot all pass a window none of them
  // has yet touched. Provisional: `recordSuccess` below forgives it in full
  // once the attempt turns out to be a legitimate login.
  deps.rateLimiter.recordFailure(key)
  // The global ceiling slows the surviving attempts down instead of refusing
  // any: an unkeyed refusal is a lockout primitive for anyone who can reach
  // `/login`. Paid before the token lookup, so the verification work a flood
  // costs us stays behind the same throttle.
  await payGlobalPenalty(deps, penalty)
  const fields = parseBodyFields(ctx.body, headerValue(ctx.headers, 'content-type'))
  const token = fields.token
  const admin =
    token !== undefined && token !== '' ? await deps.adminStore.findAdminByToken(token) : undefined
  if (admin === undefined) {
    return refuseLogin(ctx, HTTP_STATUS_UNAUTHORIZED, BODY_UNAUTHORIZED, UNKNOWN_TOKEN_NOTICE)
  }
  deps.rateLimiter.recordSuccess(key)
  const created = deps.sessions.create(admin)
  if (!created.ok) {
    // Caps are never met by evicting a live session, so a refusal is the honest
    // answer: the plane is holding as many sessions as it will hold.
    deps.stderr.write(`${SESSION_CAPACITY_WARNING} (${created.reason})\n`)
    return refuseLogin(ctx, HTTP_STATUS_TOO_MANY_REQUESTS, BODY_TOO_MANY_REQUESTS, TOO_MANY_ATTEMPTS_NOTICE)
  }
  await runAfterSignIn(deps, admin)
  return {
    kind: 'response',
    status: HTTP_STATUS_SEE_OTHER,
    headers: {
      location: POST_LOGIN_LOCATION,
      'set-cookie': serializeSessionCookie(created.sessionId, { secure: deps.behindTls }),
    },
  }
}
