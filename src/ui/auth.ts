import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { AdminRecord } from '../admin/store.js'
import type { Role } from './authz.js'
import {
  CSRF_TOKEN_RANDOM_BYTES,
  LOGIN_GLOBAL_MAX_FAILURES,
  LOGIN_GLOBAL_PENALTY_DELAY_MS,
  LOGIN_MAX_CONCURRENT_PENALTIES,
  LOGIN_MAX_FAILURES,
  LOGIN_RATE_LIMIT_MAX_KEYS,
  LOGIN_RATE_WINDOW_MS,
  MAX_SESSIONS,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME_SECURE,
  SESSION_ID_RANDOM_BYTES,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_OWNER_RESERVE_POOL_DIVISOR,
  SESSION_OWNER_RESERVED_SLOTS,
  SESSION_TTL_MS,
  SESSIONS_PER_ADMIN_MAX,
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
  /** Last request made under this session (ms epoch); drives the idle timeout. */
  readonly lastSeenAt: number
}

export interface SessionManagerOptions {
  /** Clock override for deterministic TTL in tests. */
  readonly clock?: () => number
  readonly ttlMs?: number
  /** Inactivity after which a session dies regardless of `ttlMs`. */
  readonly idleTimeoutMs?: number
  readonly maxSessions?: number
  readonly maxSessionsPerAdmin?: number
  /** Slots at the top of the pool reserved for `owner` logins. */
  readonly ownerReservedSlots?: number
}

export interface CreatedSession {
  readonly sessionId: string
  readonly session: UiSession
}

/**
 * Outcome of a login. A refusal is NOT an error: the caps exist to bound
 * memory, and (crucially) refusing is what keeps a flood of low-privilege
 * logins from evicting a live `owner` session — the previous behaviour, where
 * the oldest LIVE session was dropped to make room, was a denial-of-service
 * primitive available to any valid token holder.
 */
export type CreateSessionResult =
  | ({ readonly ok: true } & CreatedSession)
  | {
      readonly ok: false
      readonly reason: 'at-capacity' | 'per-admin-capacity' | 'reserved-for-owner'
    }

/** A session that has just been dropped, for anyone holding resources keyed on it. */
export interface DroppedSession {
  readonly sessionId: string
  readonly adminName: string
}

export interface SessionManager {
  /**
   * Mints a session for a freshly authenticated admin. Expired sessions are
   * reaped first; if a cap is still met the login is REFUSED — a live session
   * is never evicted to make room for a new one.
   */
  create(admin: AdminRecord): CreateSessionResult
  /**
   * Resolves a cookie's session id to a still-valid session, RE-CHECKING it
   * against the live admin store: an admin removed, rotated or role-changed
   * since login is rejected (and the stale entry dropped), so those actions
   * kill exactly that admin's live sessions and no others.
   */
  resolve(sessionId: string | undefined, resolver: AdminResolver): Promise<UiSession | undefined>
  /**
   * True when the session still resolves; drops it (and notifies listeners)
   * when it does not. The periodic liveness probe behind long-lived resources
   * such as SSE streams, which have no "next request" to be re-checked on.
   */
  isLive(sessionId: string, resolver: AdminResolver): Promise<boolean>
  /** Drops a session by id (logout). Idempotent. */
  destroy(sessionId: string | undefined): void
  /**
   * Registers a listener notified whenever a session is dropped (logout, TTL,
   * or a failed re-validation). Used to tear down resources bound to it.
   */
  onDropped(listener: (dropped: DroppedSession) => void): void
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

/**
 * How many top-of-pool slots only an `owner` may take. Capped at a fraction of
 * the pool so a small `maxSessions` degrades to the pre-reserve behaviour
 * instead of locking every non-owner out — the reserve exists to stop a
 * lockout, not to create a different one.
 */
export function ownerReservedSlots(maxSessions: number, configured: number): number {
  const byFraction = Math.floor(maxSessions / SESSION_OWNER_RESERVE_POOL_DIVISOR)
  return Math.max(0, Math.min(configured, byFraction))
}

export function createSessionManager(opts: SessionManagerOptions = {}): SessionManager {
  const clock = opts.clock ?? (() => Date.now())
  const ttlMs = opts.ttlMs ?? SESSION_TTL_MS
  const idleTimeoutMs = opts.idleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS
  const maxSessions = opts.maxSessions ?? MAX_SESSIONS
  const maxPerAdmin = opts.maxSessionsPerAdmin ?? SESSIONS_PER_ADMIN_MAX
  const reservedForOwner = ownerReservedSlots(
    maxSessions,
    opts.ownerReservedSlots ?? SESSION_OWNER_RESERVED_SLOTS,
  )
  /** Insertion-ordered so the oldest session is the first key. */
  const sessions = new Map<string, SessionEntry>()
  const dropListeners: Array<(dropped: DroppedSession) => void> = []

  /** Removes one session and tells everyone holding resources keyed on it. */
  function drop(sessionId: string): void {
    const entry = sessions.get(sessionId)
    if (entry === undefined) return
    sessions.delete(sessionId)
    for (const listener of dropListeners) listener({ sessionId, adminName: entry.adminName })
  }

  /** Dead = past its absolute lifetime OR idle longer than the idle window. */
  function isDead(entry: SessionEntry, now: number): boolean {
    return entry.expiresAt <= now || now - entry.lastSeenAt >= idleTimeoutMs
  }

  function reapExpired(now: number): void {
    for (const [id, entry] of [...sessions]) {
      if (isDead(entry, now)) drop(id)
    }
  }

  function countFor(adminName: string): number {
    let total = 0
    for (const entry of sessions.values()) {
      if (entry.adminName === adminName) total += 1
    }
    return total
  }

  function create(admin: AdminRecord): CreateSessionResult {
    const now = clock()
    // Reap first: an expired session is not a live one and must not block a login.
    reapExpired(now)
    if (countFor(admin.name) >= maxPerAdmin) {
      return { ok: false, reason: 'per-admin-capacity' }
    }
    if (sessions.size >= maxSessions) {
      // Refuse rather than evict: evicting the oldest LIVE session would let
      // any valid token log in `maxSessions` times and silently sign out
      // every other admin, owners included.
      return { ok: false, reason: 'at-capacity' }
    }
    if (admin.role !== 'owner' && sessions.size >= maxSessions - reservedForOwner) {
      // The landing strip. Refusing a viewer here is a smaller harm than the
      // one the M4 smoke reproduced: eight of them filling the pool and the
      // owner unable to log in for the next eight hours.
      return { ok: false, reason: 'reserved-for-owner' }
    }
    const id = randomBytes(SESSION_ID_RANDOM_BYTES).toString('base64url')
    const entry: SessionEntry = {
      id,
      adminName: admin.name,
      role: admin.role,
      csrfToken: randomBytes(CSRF_TOKEN_RANDOM_BYTES).toString('base64url'),
      tokenHash: admin.tokenHash,
      expiresAt: now + ttlMs,
      lastSeenAt: now,
    }
    sessions.set(id, entry)
    return { ok: true, sessionId: id, session: publicView(entry) }
  }

  /**
   * The one lookup path. `touch` records the request against the idle window;
   * a heartbeat liveness probe passes `false`, because counting it as activity
   * would let one forgotten tab with an open SSE stream hold its slot until the
   * absolute TTL and defeat the idle timeout outright.
   */
  async function lookup(
    sessionId: string | undefined,
    resolver: AdminResolver,
    touch: boolean,
  ): Promise<UiSession | undefined> {
    if (sessionId === undefined) return undefined
    const entry = sessions.get(sessionId)
    if (entry === undefined) return undefined
    const now = clock()
    if (isDead(entry, now)) {
      drop(sessionId)
      return undefined
    }
    const admin = await resolver.getActiveAdmin(entry.adminName)
    if (
      admin === undefined ||
      admin.revokedAt !== undefined ||
      admin.role !== entry.role ||
      admin.tokenHash !== entry.tokenHash
    ) {
      drop(sessionId)
      return undefined
    }
    // Immutable update in place: `Map.set` on an existing key keeps the entry's
    // insertion position, so the oldest-first ordering elsewhere is unaffected.
    if (touch) sessions.set(sessionId, { ...entry, lastSeenAt: now })
    return publicView(entry)
  }

  async function resolve(
    sessionId: string | undefined,
    resolver: AdminResolver,
  ): Promise<UiSession | undefined> {
    return lookup(sessionId, resolver, true)
  }

  async function isLive(sessionId: string, resolver: AdminResolver): Promise<boolean> {
    return (await lookup(sessionId, resolver, false)) !== undefined
  }

  function destroy(sessionId: string | undefined): void {
    if (sessionId !== undefined) drop(sessionId)
  }

  function onDropped(listener: (dropped: DroppedSession) => void): void {
    dropListeners.push(listener)
  }

  function size(): number {
    reapExpired(clock())
    return sessions.size
  }

  return { create, resolve, isLive, destroy, onDropped, size }
}

function publicView(entry: SessionEntry): UiSession {
  return { adminName: entry.adminName, role: entry.role, csrfToken: entry.csrfToken }
}

// ---------------------------------------------------------------------------
// Login rate limiter (sliding window over failed attempts)
// ---------------------------------------------------------------------------

/**
 * Failed logins are counted PER CLIENT (the peer address), not globally: an
 * unkeyed counter turns five wrong guesses from one machine into a lockout of
 * every admin, which is a denial-of-service any unauthenticated caller can
 * trigger at will. A looser global ceiling stays as a backstop for a
 * distributed flood, since per-key windows alone are unbounded work.
 *
 * The global ceiling DELAYS rather than refuses. Refusing on an unkeyed counter
 * is the same lockout primitive in slower motion: any process that can reach
 * `/login` — 127.0.0.0/8 aliases are enough — spends `globalMaxFailures` wrong
 * guesses and nobody logs in until the window slides. A delay costs a flood the
 * same throughput while a legitimate login merely pauses.
 *
 * The key map is capped (`LOGIN_RATE_LIMIT_MAX_KEYS`) so a spoofed-source flood
 * cannot grow it without bound; the oldest-touched key is dropped when full,
 * which at worst forgives one attacker's history — never a lockout.
 */
export interface LoginRateLimiter {
  /** True if another attempt from `key` is allowed right now (per-key window only). */
  allow(key: string): boolean
  /**
   * Delay to serve this attempt behind, in ms — non-zero only while the global
   * ceiling is exceeded. Read before `allow`, but paid only by attempts `allow`
   * ADMITTED: an attempt already refused by its own key learns nothing from the
   * pause, and holding a socket on behalf of a caller we have refused is a cost
   * to us and not to them.
   */
  penaltyMs(key: string): number
  /**
   * Counts one attempt from `key` against both windows.
   *
   * Named for what it is used for and not for what it means: the caller records
   * it PROVISIONALLY, immediately after `allow` and before the token is even
   * looked up, then calls `recordSuccess` to forgive it if the login turns out
   * to be genuine. That ordering is the whole per-key guarantee — counting only
   * after the token check leaves an `await` between the check and the count, and
   * every attempt already in flight passes an untouched window (a burst of
   * `LOGIN_MAX_CONCURRENT_PENALTIES` against an allowance of
   * `LOGIN_MAX_FAILURES`). Adjacent synchronous calls have no such gap.
   *
   * Consequence for the global window, which `recordSuccess` does NOT forgive:
   * it counts admitted attempts, not failures. See `LOGIN_GLOBAL_MAX_FAILURES`.
   */
  recordFailure(key: string): void
  /** Clears that key's window, forgiving its provisional count, on a successful login. */
  recordSuccess(key: string): void
  /**
   * Clears that key's window AND forgives exactly the one GLOBAL entry this
   * key's own `recordFailure` added — never a different key's, and never more
   * than one, however many other attempts are interleaved with this one's own
   * `await`s in between.
   *
   * `recordSuccess` (above) is `/login`'s own method and its global window is
   * left untouched ON PURPOSE — its doc comment explains why. This is a
   * SEPARATE method for the console API's Bearer path (`console-auth.ts`,
   * ADR-0014 review): unlike a human typing a password, a Bearer request is
   * every console action, including ones nobody sat down to type — a hundred
   * of them left sitting in the global window would make every `/login` and
   * every OTHER console request pay the shared penalty behind them, for
   * traffic that never guessed anything. Named for what it is used for
   * (an admin was just authenticated), not for the mechanism.
   */
  recordAuthenticated(key: string): void
}

export interface RateLimiterOptions {
  readonly clock?: () => number
  /** Failures tolerated from ONE key within the window. */
  readonly maxFailures?: number
  /** Failures tolerated across ALL keys within the window (flood backstop). */
  readonly globalMaxFailures?: number
  readonly windowMs?: number
  /** Cap on tracked keys before the least-recently-touched is forgotten. */
  readonly maxKeys?: number
  /** Delay applied to every attempt while the global ceiling is exceeded. */
  readonly globalPenaltyMs?: number
}

/** Drops timestamps older than the window; returns the surviving ones. */
function withinWindow(timestamps: readonly number[], cutoff: number): number[] {
  return timestamps.filter((ts) => ts > cutoff)
}

/**
 * One entry of the GLOBAL window, tagged with the key that added it. The
 * tag is what makes `recordAuthenticated` safe under interleaving: without
 * it, forgiving "the most recent global timestamp" could remove a different,
 * still-unresolved caller's entry instead of the one THIS success itself
 * contributed (security review: "a success cannot forgive somebody else's
 * failure beyond its own one entry").
 */
interface GlobalEntry {
  readonly ts: number
  readonly key: string
}

/** Drops global entries older than the window; returns the surviving ones. */
function withinGlobalWindow(entries: readonly GlobalEntry[], cutoff: number): GlobalEntry[] {
  return entries.filter((entry) => entry.ts > cutoff)
}

/**
 * The index of the LAST (most recent) entry tagged with `key`, or -1. A hand
 * written reverse scan rather than `Array.prototype.findLastIndex`: the
 * project's `lib` target is ES2022 (`tsconfig.json`), one edition behind that
 * method, and this is one small function rather than a project-wide lib bump.
 */
function lastIndexByKey(entries: readonly GlobalEntry[], key: string): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.key === key) return index
  }
  return -1
}

export function createLoginRateLimiter(opts: RateLimiterOptions = {}): LoginRateLimiter {
  const clock = opts.clock ?? (() => Date.now())
  const maxFailures = opts.maxFailures ?? LOGIN_MAX_FAILURES
  const globalMaxFailures = opts.globalMaxFailures ?? LOGIN_GLOBAL_MAX_FAILURES
  const windowMs = opts.windowMs ?? LOGIN_RATE_WINDOW_MS
  const maxKeys = opts.maxKeys ?? LOGIN_RATE_LIMIT_MAX_KEYS
  const globalPenaltyMs = opts.globalPenaltyMs ?? LOGIN_GLOBAL_PENALTY_DELAY_MS
  /** Insertion-ordered: re-inserting on touch makes the first key the LRU one. */
  const perKey = new Map<string, number[]>()
  let global: GlobalEntry[] = []

  function prune(key: string, now: number): number[] {
    const cutoff = now - windowMs
    global = withinGlobalWindow(global, cutoff)
    const kept = withinWindow(perKey.get(key) ?? [], cutoff)
    if (kept.length === 0) perKey.delete(key)
    else perKey.set(key, kept)
    return kept
  }

  function touch(key: string, timestamps: number[]): void {
    // Re-insert so the key moves to the back of the LRU order.
    perKey.delete(key)
    perKey.set(key, timestamps)
    while (perKey.size > maxKeys) {
      const lru = perKey.keys().next().value
      if (lru === undefined) break
      perKey.delete(lru)
    }
  }

  return {
    allow(key: string): boolean {
      const now = clock()
      const kept = prune(key, now)
      // The global window deliberately does NOT refuse here — see `penaltyMs`.
      return kept.length < maxFailures
    },
    penaltyMs(key: string): number {
      const now = clock()
      prune(key, now)
      return global.length >= globalMaxFailures ? globalPenaltyMs : 0
    },
    recordFailure(key: string): void {
      const now = clock()
      const kept = prune(key, now)
      touch(key, [...kept, now])
      global = [...global, { ts: now, key }]
    },
    recordSuccess(key: string): void {
      perKey.delete(key)
    },
    recordAuthenticated(key: string): void {
      perKey.delete(key)
      // Remove the NEWEST entry tagged with this key — under interleaving
      // there may be more than one still outstanding for the same key (two
      // concurrent requests with the same token), and removing the most
      // recent one is enough: it is still exactly one entry per call, and
      // which of a key's own several entries is removed makes no observable
      // difference to the count.
      const index = lastIndexByKey(global, key)
      if (index === -1) return
      global = [...global.slice(0, index), ...global.slice(index + 1)]
    },
  }
}

/**
 * Bounds how many login attempts wait out the global penalty delay at once.
 *
 * The delay is a throttle, not a control: holding a request open costs a socket
 * and a handler, and while the ceiling is tripped EVERY attempt pays it. Without
 * a bound, a sustained flood converts "one second of delay" into an unbounded
 * number of concurrently held connections — the cost the delay was supposed to
 * impose on the attacker, imposed on us instead.
 *
 * `acquire()` returning false means "serve this attempt WITHOUT the delay",
 * never "refuse it": degrading to the pre-penalty behaviour denies nobody,
 * while refusing would restore the unkeyed lockout primitive the delay replaced.
 */
export interface PenaltyGate {
  /** Takes a slot if one is free. False = skip the delay for this attempt. */
  acquire(): boolean
  /** Returns a slot. Never drives the count below zero. */
  release(): void
}

export function createPenaltyGate(
  opts: { readonly maxConcurrent?: number } = {},
): PenaltyGate {
  const maxConcurrent = opts.maxConcurrent ?? LOGIN_MAX_CONCURRENT_PENALTIES
  let inFlight = 0
  return {
    acquire(): boolean {
      if (inFlight >= maxConcurrent) return false
      inFlight += 1
      return true
    },
    release(): void {
      // Clamped: an unbalanced release must not mint capacity beyond the cap.
      if (inFlight > 0) inFlight -= 1
    },
  }
}

/**
 * Rate-limit key for a login attempt.
 *
 * By default the peer address, which is the only value the plane can vouch for.
 * Behind a reverse proxy every login arrives from the proxy's address and the
 * per-address window collapses into one shared bucket — so an operator may opt
 * in to a trusted forwarding header with `--trusted-proxy-header`.
 *
 * The RIGHTMOST element is taken, never the leftmost: a client that
 * pre-populates the header gets its value pushed left by the proxy's append, so
 * the last element is the one the trusted hop wrote. A proxy that overwrites
 * the header instead leaves exactly one element, and the same rule reads it.
 *
 * This is opt-in for a reason: trusting the header with no proxy in front (or
 * with one that forwards the client's copy unchanged) hands every caller a
 * free-form key and makes the window trivially evadable. README says so at the
 * flag.
 */
export function loginRateLimitKey(
  req: Pick<IncomingMessage, 'headers' | 'socket'>,
  trustedProxyHeader?: string,
): string {
  const peer = req.socket.remoteAddress ?? 'unknown'
  if (trustedProxyHeader === undefined) return peer
  const raw = req.headers[trustedProxyHeader.toLowerCase()]
  const value = Array.isArray(raw) ? raw.join(',') : raw
  if (value === undefined) return peer
  const hops = value
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop !== '')
  return hops.at(-1) ?? peer
}

// ---------------------------------------------------------------------------
// Cookie parsing / serialization
// ---------------------------------------------------------------------------

/**
 * The cookie name for the mode. Behind TLS the `__Host-` prefixed name is the
 * ONLY one read or written: accepting the unprefixed name as well would restore
 * the exact fixation the prefix exists to block, since a sibling subdomain can
 * set that one and the browser would send both.
 */
export function sessionCookieName(opts: { secure: boolean }): string {
  return opts.secure ? SESSION_COOKIE_NAME_SECURE : SESSION_COOKIE_NAME
}

/** Extracts the session id from a raw `Cookie` header, or `undefined`. */
export function parseSessionCookie(
  cookieHeader: string | undefined,
  opts: { secure: boolean } = { secure: false },
): string | undefined {
  if (cookieHeader === undefined) return undefined
  const wanted = sessionCookieName(opts)
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === wanted) {
      const value = part.slice(eq + 1).trim()
      return value === '' ? undefined : value
    }
  }
  return undefined
}

/** Builds the `Set-Cookie` value for a new session (HttpOnly, SameSite=Strict, Path=/). */
export function serializeSessionCookie(sessionId: string, opts: { secure: boolean }): string {
  return cookieAttributes(`${sessionCookieName(opts)}=${sessionId}`, opts).join('; ')
}

/** Builds the `Set-Cookie` value that clears the session cookie (logout). */
export function clearSessionCookie(opts: { secure: boolean }): string {
  return [...cookieAttributes(`${sessionCookieName(opts)}=`, opts), 'Max-Age=0'].join('; ')
}

/**
 * The shared attribute set. `Path=/` and the absence of `Domain` are not
 * cosmetic: `__Host-` is invalid without both, so the secure name would be
 * silently dropped by the browser if either ever changed.
 */
function cookieAttributes(nameValue: string, opts: { secure: boolean }): string[] {
  const attributes = [nameValue, 'HttpOnly', 'SameSite=Strict', 'Path=/']
  if (opts.secure) attributes.push('Secure')
  return attributes
}
