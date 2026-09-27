import { randomBytes } from 'node:crypto'
import type { AccountRecord } from './accounts-db.js'

/**
 * Hub sessions (plan `hub-signin-accounts`, Task 5, H2): in memory only — a
 * restart signs everyone out, which costs one click on "Sign in with GitHub"
 * and means a copy of the data directory holds no session material. The
 * shape follows the console's `SessionManager` (`src/ui/auth.ts`): a random
 * id in an HttpOnly `SameSite=Strict` cookie, a CSRF token per session, an
 * absolute lifetime plus an idle timeout. Not imported: `src/ui/auth.ts` is
 * not on the H1 allowlist.
 *
 * Every `resolve` re-reads the account: a session is bound to the account
 * row it was created for (GitHub id AND creation time), so an operator's
 * `block`, a `delete`, or a later re-signup of the same GitHub id each end
 * the old session on its next request — nothing waits for the TTL.
 */

export const HUB_SESSION_COOKIE_NAME = '__Host-mcpcut_hub'
export const HUB_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const HUB_SESSION_IDLE_MS = 24 * 60 * 60 * 1000
/** Browsers one person may be signed in from at once; the oldest retires. */
export const HUB_SESSIONS_PER_ACCOUNT_MAX = 8
/** A backstop far above `maxAccounts × HUB_SESSIONS_PER_ACCOUNT_MAX`. */
export const HUB_MAX_SESSIONS = 10_000

/** 32 bytes → 43 base64url characters, for the session id and the CSRF token. */
const SESSION_RANDOM_BYTES = 32
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * `Strict`: the session is only ever needed on requests a page of the hub
 * itself makes. The one cross-site arrival — GitHub's redirect to the
 * callback — is carried by the flow cookie (`oauth-flow.ts`, `Lax`), and the
 * callback hands over to `/account` through a same-site step, not a redirect
 * (`pages/signed-in.ts`). `__Host-` pins `Secure`, `Path=/` and no `Domain`,
 * so a tenant page on `*.mcpcut.com` cannot plant one for the apex.
 */
const COOKIE_ATTRIBUTES = ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'] as const
const COOKIE_MAX_AGE_SECONDS = HUB_SESSION_TTL_MS / 1000

/** What a handler sees about the caller. */
export interface HubSession {
  readonly githubId: number
  /** Per-session anti-CSRF token; embedded in pages, echoed by every POST. */
  readonly csrfToken: string
}

export type SessionResolution =
  | { readonly kind: 'none' }
  /** The account behind a live session was blocked; the session is gone now. */
  | { readonly kind: 'blocked' }
  /**
   * The account behind a live session is gone or was re-created; the session
   * is gone now. Names the account it was for, so the caller can say why
   * (an install that could not be created — `provisioning.ts`, P3).
   */
  | { readonly kind: 'ended'; readonly githubId: number; readonly accountCreatedAt: string }
  | { readonly kind: 'live'; readonly session: HubSession; readonly account: AccountRecord }

export interface HubSessions {
  create(account: AccountRecord): { readonly sessionId: string; readonly session: HubSession }
  resolve(sessionId: string | undefined): SessionResolution
  destroy(sessionId: string | undefined): void
  /** Ends every session of one account (after a delete). */
  destroyAccount(githubId: number): void
  size(): number
}

export interface HubSessionsOptions {
  /** The account's CURRENT row, read on every resolve. */
  readonly findAccount: (githubId: number) => AccountRecord | null
  readonly clock?: () => number
  readonly ttlMs?: number
  readonly idleMs?: number
  readonly maxPerAccount?: number
  readonly maxSessions?: number
}

interface SessionEntry extends HubSession {
  /** The account row's `createdAt` at sign-in: a re-created account is a different one. */
  readonly accountCreatedAt: string
  readonly expiresAt: number
  readonly lastSeenAt: number
}

export function createHubSessions(options: HubSessionsOptions): HubSessions {
  const clock = options.clock ?? Date.now
  const ttlMs = options.ttlMs ?? HUB_SESSION_TTL_MS
  const idleMs = options.idleMs ?? HUB_SESSION_IDLE_MS
  const maxPerAccount = options.maxPerAccount ?? HUB_SESSIONS_PER_ACCOUNT_MAX
  const maxSessions = options.maxSessions ?? HUB_MAX_SESSIONS
  /** Insertion-ordered, so the first key is always the oldest session. */
  const sessions = new Map<string, SessionEntry>()

  const isDead = (entry: SessionEntry, now: number): boolean =>
    entry.expiresAt <= now || now - entry.lastSeenAt >= idleMs

  function reap(now: number): void {
    for (const [id, entry] of [...sessions]) if (isDead(entry, now)) sessions.delete(id)
  }

  function idsOf(githubId: number): string[] {
    return [...sessions].filter(([, entry]) => entry.githubId === githubId).map(([id]) => id)
  }

  /** Makes room for one more: the account's own oldest first, then the oldest overall. */
  function makeRoom(githubId: number): void {
    const own = idsOf(githubId)
    for (const id of own.slice(0, Math.max(0, own.length - maxPerAccount + 1))) sessions.delete(id)
    while (sessions.size >= maxSessions) {
      const oldest = sessions.keys().next().value
      if (oldest === undefined) break
      sessions.delete(oldest)
    }
  }

  function create(account: AccountRecord): { sessionId: string; session: HubSession } {
    const now = clock()
    reap(now)
    makeRoom(account.githubId)
    const sessionId = randomValue()
    const entry: SessionEntry = {
      githubId: account.githubId,
      csrfToken: randomValue(),
      accountCreatedAt: account.createdAt,
      expiresAt: now + ttlMs,
      lastSeenAt: now,
    }
    sessions.set(sessionId, entry)
    return { sessionId, session: publicView(entry) }
  }

  function resolve(sessionId: string | undefined): SessionResolution {
    if (sessionId === undefined) return { kind: 'none' }
    const entry = sessions.get(sessionId)
    if (entry === undefined) return { kind: 'none' }
    const now = clock()
    if (isDead(entry, now)) {
      sessions.delete(sessionId)
      return { kind: 'none' }
    }
    const account = options.findAccount(entry.githubId)
    if (account === null || account.createdAt !== entry.accountCreatedAt) {
      sessions.delete(sessionId)
      return { kind: 'ended', githubId: entry.githubId, accountCreatedAt: entry.accountCreatedAt }
    }
    if (account.status === 'blocked') {
      sessions.delete(sessionId)
      return { kind: 'blocked' }
    }
    // `Map.set` on an existing key keeps its position: oldest-first order holds.
    sessions.set(sessionId, { ...entry, lastSeenAt: now })
    return { kind: 'live', session: publicView(entry), account }
  }

  return {
    create,
    resolve,
    destroy: (sessionId) => {
      if (sessionId !== undefined) sessions.delete(sessionId)
    },
    destroyAccount: (githubId) => {
      for (const id of idsOf(githubId)) sessions.delete(id)
    },
    size: () => {
      reap(clock())
      return sessions.size
    },
  }
}

function publicView(entry: SessionEntry): HubSession {
  return { githubId: entry.githubId, csrfToken: entry.csrfToken }
}

function randomValue(): string {
  return randomBytes(SESSION_RANDOM_BYTES).toString('base64url')
}

/** The `Set-Cookie` value for a new session. */
export function serializeHubSessionCookie(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    // A value outside the pattern could smuggle attributes (`; Domain=…`).
    throw new TypeError('serializeHubSessionCookie: not a session id')
  }
  return [`${HUB_SESSION_COOKIE_NAME}=${sessionId}`, ...COOKIE_ATTRIBUTES, `Max-Age=${COOKIE_MAX_AGE_SECONDS}`].join('; ')
}

/** The `Set-Cookie` value that removes the session cookie. */
export function clearHubSessionCookie(): string {
  return [`${HUB_SESSION_COOKIE_NAME}=`, ...COOKIE_ATTRIBUTES, 'Max-Age=0'].join('; ')
}

/**
 * The session id from a `Cookie` header, or `undefined`. Malformed reads as
 * absent; two different values under the name read as absent too — guessing
 * which one is ours is how a planted cookie would win (as `oauth-flow.ts`).
 */
export function sessionIdFromCookieHeader(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const values = new Set<string>()
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1 || part.slice(0, eq).trim() !== HUB_SESSION_COOKIE_NAME) continue
    values.add(part.slice(eq + 1).trim())
  }
  if (values.size !== 1) return undefined
  const [value] = values
  return value !== undefined && SESSION_ID_PATTERN.test(value) ? value : undefined
}
