import type { IncomingMessage } from 'node:http'
import type { AdminRecord } from '../admin/store.js'
import { BEARER_PREFIX } from '../console-api/contract.js'
import type { AdminResolver, LoginRateLimiter } from './auth.js'
import { loginRateLimitKey } from './auth.js'
import { payGlobalPenalty, type GlobalPenaltyDeps } from './login-flow.js'
import { headerValue } from './routes.js'

/**
 * Bearer authentication for the console API (ADR-0014): every request names
 * its caller with `Authorization: Bearer <admin token>`, never a cookie —
 * there is no console-side session, no `Set-Cookie`, and the admin store's
 * own hash comparison is the whole of it.
 *
 * Shares `/login`'s keyed rate limiter deliberately (the SAME instance, wired
 * in by the caller): an address that has spent its budget guessing `/login`
 * tokens cannot turn around and spend a second one guessing here, and the
 * counting discipline is the one `login-flow.ts` already uses — the attempt
 * is recorded BEFORE the store is asked, so concurrent attempts on one key
 * cannot all pass a window none of them has yet touched.
 *
 * The GLOBAL ceiling is paid here too (security review, H1): a Bearer token is
 * the very credential `/login` takes, and a door that skipped the delay would
 * be the cheaper place to guess it — while its failures still filled the
 * shared global window and slowed every honest sign-in instead.
 *
 * A SUCCESSFUL resolution, though, does NOT behave like `/login`'s (MEDIUM/HIGH
 * follow-up review): it calls `recordAuthenticated`, not `recordSuccess`. Every
 * console action — including the automatic background ones a signed-in
 * console fires without a keystroke — is one of these requests, and each one
 * provisionally counts against the shared GLOBAL window before the token is
 * even looked up. Leaving that count in place for a full window (as `/login`'s
 * own `recordSuccess` deliberately does for ITS global window) would mean
 * roughly a hundred ordinary, legitimate console requests are enough to make
 * every `/login` attempt — and every OTHER console request — pay the global
 * penalty behind them. `recordAuthenticated` forgives exactly the one entry
 * this request's own `recordFailure` added, and no other caller's.
 */

export interface ConsoleBearerDeps extends GlobalPenaltyDeps {
  readonly adminStore: AdminResolver
  readonly rateLimiter: LoginRateLimiter
  readonly trustedProxyHeader?: string
}

export type ConsoleBearerResult =
  | { readonly kind: 'ok'; readonly admin: AdminRecord; readonly token: string }
  | { readonly kind: 'rate-limited' }
  | { readonly kind: 'unauthorized' }

/** The bearer token in an `Authorization` header, or `undefined` for anything else (missing, wrong scheme, empty). */
function bearerTokenOf(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) return undefined
  const token = header.slice(BEARER_PREFIX.length)
  return token === '' ? undefined : token
}

/**
 * Resolves the caller of one console-API request. A missing header, a wrong
 * scheme, an empty token, an unknown token and a revoked admin's token all
 * resolve to the same `'unauthorized'` — no oracle over which of those it was
 * (`console-api.ts`/`console-run.ts` answer every one with the identical
 * byte-for-byte JSON body).
 */
export async function resolveConsoleBearer(
  deps: ConsoleBearerDeps,
  req: IncomingMessage,
): Promise<ConsoleBearerResult> {
  const key = loginRateLimitKey(req, deps.trustedProxyHeader)
  const penalty = deps.rateLimiter.penaltyMs(key)
  if (!deps.rateLimiter.allow(key)) return { kind: 'rate-limited' }
  // Counted here, one statement after the check and before the first `await`
  // — the same ordering `login-flow.ts` relies on, for the same reason.
  deps.rateLimiter.recordFailure(key)
  // Before the lookup, as in `/login`: the verification work a flood costs us
  // stays behind the same throttle.
  await payGlobalPenalty(deps, penalty)
  const token = bearerTokenOf(headerValue(req.headers, 'authorization'))
  const admin = token !== undefined ? await deps.adminStore.findAdminByToken(token) : undefined
  if (admin === undefined || token === undefined) return { kind: 'unauthorized' }
  // `recordAuthenticated`, not `recordSuccess`: this is not `/login`, whose
  // global window deliberately keeps counting admitted attempts. A Bearer
  // request is every console action — including automatic ones nobody typed
  // — so a legitimate one must not sit in the shared global window making
  // every OTHER caller (including `/login` itself) pay its penalty behind it.
  deps.rateLimiter.recordAuthenticated(key)
  return { kind: 'ok', admin, token }
}
