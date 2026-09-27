/**
 * What a background install creation leaves for its person (plan
 * `hosted-path-and-ops`, Task A, P2/P3): either the install's first owner
 * token, waiting for `/account` to show it once, or a mark that the creation
 * failed, waiting for `/account` to say so once. In memory only — a restart
 * loses a waiting token, which costs one "issue a new owner token" click, and
 * means no copy of the data directory ever holds one.
 *
 * One entry per GitHub id, bound to the account row's `createdAt` (as a
 * session is, `sessions.ts`): a token minted for one account never reaches a
 * later account of the same person. Reading an entry removes it, whatever the
 * answer. Nothing here logs, and the store renders as nothing — the token
 * lives only in a closure.
 */

/** How long a token or a failure mark waits to be read. */
export const PENDING_TOKEN_TTL_MS = 15 * 60 * 1000
/** A backstop far above the hub's account cap: the oldest entry goes first. */
export const PENDING_ENTRIES_MAX = 1_000

/** Which account an entry belongs to: the GitHub id AND the row's creation time. */
export interface PendingKey {
  readonly githubId: number
  readonly accountCreatedAt: string
}

export interface PendingTokens {
  /** Leaves `token` for the account; replaces whatever waited for it. */
  putToken(key: PendingKey, token: string): void
  /** The waiting token, once; `undefined` when none waits for exactly this account. */
  takeToken(key: PendingKey): string | undefined
  /** Leaves a "creation failed" mark; replaces whatever waited for it. */
  markFailed(key: PendingKey): void
  /** Whether a failure mark waited for exactly this account; reading it removes it. */
  takeFailed(key: PendingKey): boolean
  /** Drops whatever waits for this GitHub id (a rotation, a deletion). */
  forget(githubId: number): void
  size(): number
}

export interface PendingTokensOptions {
  readonly clock?: () => number
  readonly ttlMs?: number
  readonly maxEntries?: number
}

type Waiting = { readonly kind: 'token'; readonly token: string } | { readonly kind: 'failed' }

interface Entry {
  readonly accountCreatedAt: string
  readonly waiting: Waiting
  readonly expiresAt: number
}

export function createPendingTokens(options: PendingTokensOptions = {}): PendingTokens {
  const clock = options.clock ?? Date.now
  const ttlMs = options.ttlMs ?? PENDING_TOKEN_TTL_MS
  const maxEntries = options.maxEntries ?? PENDING_ENTRIES_MAX
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('createPendingTokens: maxEntries must be a positive integer')
  /** Insertion-ordered, so the first key is always the oldest entry. */
  const entries = new Map<number, Entry>()

  function reap(now: number): void {
    for (const [githubId, entry] of [...entries]) if (entry.expiresAt <= now) entries.delete(githubId)
  }

  function put(key: PendingKey, waiting: Waiting): void {
    const now = clock()
    reap(now)
    // Delete first: a replaced entry moves to the young end of the order.
    entries.delete(key.githubId)
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
    entries.set(key.githubId, { accountCreatedAt: key.accountCreatedAt, waiting, expiresAt: now + ttlMs })
  }

  /** The live entry for exactly this account, removed; `undefined` otherwise (a stale one is removed too). */
  function take(key: PendingKey): Waiting | undefined {
    reap(clock())
    const entry = entries.get(key.githubId)
    if (entry === undefined) return undefined
    entries.delete(key.githubId)
    return entry.accountCreatedAt === key.accountCreatedAt ? entry.waiting : undefined
  }

  return Object.freeze({
    putToken: (key: PendingKey, token: string) => put(key, { kind: 'token', token }),
    takeToken: (key: PendingKey) => {
      const waiting = take(key)
      return waiting?.kind === 'token' ? waiting.token : undefined
    },
    markFailed: (key: PendingKey) => put(key, { kind: 'failed' }),
    takeFailed: (key: PendingKey) => take(key)?.kind === 'failed',
    forget: (githubId: number) => {
      entries.delete(githubId)
    },
    size: () => {
      reap(clock())
      return entries.size
    },
    toString: () => '[PendingTokens]',
  })
}
