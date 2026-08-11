import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AdminRecord } from '../admin/store.js'
import type { Role } from './authz.js'
import {
  CSRF_TOKEN_RANDOM_BYTES,
  LOGIN_MAX_FAILURES,
  LOGIN_RATE_WINDOW_MS,
  MAX_SESSIONS,
  SESSION_COOKIE_NAME,
  SESSION_ID_RANDOM_BYTES,
  SESSION_TTL_MS,
} from './constants.js'

/**
 * Human authentication for the admin UI (ADR-0004, Decision 3): in-memory,
 * non-persisted cookie sessions, per-session CSRF tokens, and a login rate
 * limiter. Nothing here touches disk — sessions die with the process, so a
 * copy of the state directory yields no session material.
 *
 * The only credential the store persists is a token HASH; this module never
 * sees a plaintext admin token except transiently during `findAdminByToken`
 * (in the store), and never logs, echoes or stores one.
 */

/** The subset of the admin store this module depends on (freshness re-check + login). */
export interface AdminResolver {
  /** Resolves a plaintext token to its active admin, or `undefined`. */
  findAdminByToken(token: string): Promise<AdminRecord | undefined>
  /** The active admin by name, for per-request session freshness re-validation. */
  getActiveAdmin(name: string): Promise<AdminRecord | undefined>
}

/** What a handler sees about the caller (never the session id or token hash). */
export interface UiSession {
  readonly adminName: string
  readonly role: Role
  /** Per-session anti-CSRF token; embedded in pages and echoed by state-changing requests. */
  readonly csrfToken: string
}

/** Internal record: the public session plus the bindings the server re-checks. */
interface SessionEntry extends UiSession {
  readonly id: string
  /** The admin's token hash at login; a rotate changes it and invalidates this session. */
  readonly tokenHash: string
  /** Absolute expiry (ms epoch). */
  readonly expiresAt: number
}

export interface SessionManagerOptions {
  /** Clock override for deterministic TTL in tests. */
  readonly clock?: () => number
  readonly ttlMs?: number
  readonly maxSessions?: number
}

export interface CreatedSession {
  readonly sessionId: string
  readonly session: UiSession
}

export interface SessionManager {
  /** Mints a session for a freshly authenticated admin; returns the cookie id. */
  create(admin: AdminRecord): CreatedSession
  /**
   * Resolves a cookie's session id to a still-valid session, RE-CHECKING it
   * against the live admin store: an admin removed, rotated or role-changed
   * since login is rejected (and the stale entry dropped), so those actions
   * kill exactly that admin's live sessions and no others.
   */
  resolve(sessionId: string | undefined, resolver: AdminResolver): Promise<UiSession | undefined>
  /** Drops a session by id (logout). Idempotent. */
  destroy(sessionId: string | undefined): void
  /** Live (unexpired) session count — for tests and the cap. */
  size(): number
}

/** Constant-time equality over two same-scheme tokens (CSRF, session ids). */
export function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function createSessionManager(opts: SessionManagerOptions = {}): SessionManager {
  const clock = opts.clock ?? (() => Date.now())
  const ttlMs = opts.ttlMs ?? SESSION_TTL_MS
  const maxSessions = opts.maxSessions ?? MAX_SESSIONS
  /** Insertion-ordered so the oldest session is the first key. */
  const sessions = new Map<string, SessionEntry>()

  function evictExpired(now: number): void {
    for (const [id, entry] of sessions) {
      if (entry.expiresAt <= now) sessions.delete(id)
    }
  }

  function create(admin: AdminRecord): CreatedSession {
    const now = clock()
    evictExpired(now)
    // Enforce the cap by dropping the oldest live session (Map is insertion-ordered).
    while (sessions.size >= maxSessions) {
      const oldest = sessions.keys().next().value
      if (oldest === undefined) break
      sessions.delete(oldest)
    }
    const id = randomBytes(SESSION_ID_RANDOM_BYTES).toString('base64url')
    const entry: SessionEntry = {
      id,
      adminName: admin.name,
      role: admin.role,
      csrfToken: randomBytes(CSRF_TOKEN_RANDOM_BYTES).toString('base64url'),
      tokenHash: admin.tokenHash,
      expiresAt: now + ttlMs,
    }
    sessions.set(id, entry)
    return { sessionId: id, session: publicView(entry) }
  }

  async function resolve(
    sessionId: string | undefined,
    resolver: AdminResolver,
  ): Promise<UiSession | undefined> {
    if (sessionId === undefined) return undefined
    const entry = sessions.get(sessionId)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= clock()) {
      sessions.delete(sessionId)
      return undefined
    }
    const admin = await resolver.getActiveAdmin(entry.adminName)
    if (
      admin === undefined ||
      admin.revokedAt !== undefined ||
      admin.role !== entry.role ||
      admin.tokenHash !== entry.tokenHash
    ) {
      sessions.delete(sessionId)
      return undefined
    }
    return publicView(entry)
  }

  function destroy(sessionId: string | undefined): void {
    if (sessionId !== undefined) sessions.delete(sessionId)
  }

  function size(): number {
    evictExpired(clock())
    return sessions.size
  }

  return { create, resolve, destroy, size }
}

function publicView(entry: SessionEntry): UiSession {
  return { adminName: entry.adminName, role: entry.role, csrfToken: entry.csrfToken }
}

// ---------------------------------------------------------------------------
// Login rate limiter (sliding window over failed attempts)
// ---------------------------------------------------------------------------

export interface LoginRateLimiter {
  /** True if another attempt is allowed right now. */
  allow(): boolean
  /** Records a failed login (counts toward the window). */
  recordFailure(): void
  /** Clears the window on a successful login. */
  recordSuccess(): void
}

export interface RateLimiterOptions {
  readonly clock?: () => number
  readonly maxFailures?: number
  readonly windowMs?: number
}

export function createLoginRateLimiter(opts: RateLimiterOptions = {}): LoginRateLimiter {
  const clock = opts.clock ?? (() => Date.now())
  const maxFailures = opts.maxFailures ?? LOGIN_MAX_FAILURES
  const windowMs = opts.windowMs ?? LOGIN_RATE_WINDOW_MS
  let failures: number[] = []

  function prune(now: number): void {
    const cutoff = now - windowMs
    failures = failures.filter((ts) => ts > cutoff)
  }

  return {
    allow(): boolean {
      prune(clock())
      return failures.length < maxFailures
    },
    recordFailure(): void {
      failures.push(clock())
    },
    recordSuccess(): void {
      failures = []
    },
  }
}

// ---------------------------------------------------------------------------
// Cookie parsing / serialization
// ---------------------------------------------------------------------------

/** Extracts the session id from a raw `Cookie` header, or `undefined`. */
export function parseSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === SESSION_COOKIE_NAME) {
      const value = part.slice(eq + 1).trim()
      return value === '' ? undefined : value
    }
  }
  return undefined
}

/** Builds the `Set-Cookie` value for a new session (HttpOnly, SameSite=Strict, Path=/). */
export function serializeSessionCookie(sessionId: string, opts: { secure: boolean }): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
  ]
  if (opts.secure) attributes.push('Secure')
  return attributes.join('; ')
}

/** Builds the `Set-Cookie` value that clears the session cookie (logout). */
export function clearSessionCookie(opts: { secure: boolean }): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ]
  if (opts.secure) attributes.push('Secure')
  return attributes.join('; ')
}
