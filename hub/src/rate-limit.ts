import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'

/**
 * Per-IP rate limits for the hub (plan `hub-signin-accounts`, Task 5, HA12):
 * a sliding-window counter keyed by client address, and the rule that says
 * which address a request counts against (H6).
 *
 * The hub's own copy of the window idea behind the console's login limiter
 * (`src/ui/auth.ts`, `createLoginRateLimiter`) — not an import: `src/ui/auth.ts`
 * is not on the H1 allowlist (it reaches the admin store). It is simpler on
 * purpose: the hub limits admitted REQUESTS (`/signin`, the callback) and
 * CREATED ACCOUNTS, not failed guesses, so there is no success to forgive and
 * no global penalty to pay.
 */

/** Keys tracked before the least recently touched one is forgotten. Bounds
 * memory under a spoofed-source flood; at worst it forgives one address. */
export const RATE_LIMIT_MAX_KEYS = 4096

export interface WindowCounterOptions {
  readonly windowMs: number
  readonly maxKeys?: number
  readonly clock?: () => number
}

export interface WindowCounter {
  /** Hits recorded for `key` inside the trailing window. */
  count(key: string): number
  /** Records one hit for `key` now. */
  record(key: string): void
  /**
   * Records a hit and answers `true` while `key` is under `limit`; answers
   * `false` WITHOUT recording once it is not, so a refused caller cannot
   * push its own window further out by hammering.
   */
  tryConsume(key: string, limit: number): boolean
}

export function createWindowCounter(options: WindowCounterOptions): WindowCounter {
  const { windowMs } = options
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError(`createWindowCounter: windowMs must be a positive finite number, got ${windowMs}`)
  }
  const maxKeys = options.maxKeys ?? RATE_LIMIT_MAX_KEYS
  const clock = options.clock ?? Date.now
  /** Insertion-ordered: re-inserting on touch makes the first key the LRU one. */
  const hits = new Map<string, readonly number[]>()

  function live(key: string): readonly number[] {
    const cutoff = clock() - windowMs
    const kept = (hits.get(key) ?? []).filter((at) => at > cutoff)
    if (kept.length === 0) hits.delete(key)
    return kept
  }

  function record(key: string): void {
    const next = [...live(key), clock()]
    hits.delete(key)
    hits.set(key, next)
    while (hits.size > maxKeys) {
      const oldest = hits.keys().next().value
      if (oldest === undefined) break
      hits.delete(oldest)
    }
  }

  return {
    count: (key) => live(key).length,
    record,
    tryConsume(key, limit) {
      if (live(key).length >= limit) return false
      record(key)
      return true
    },
  }
}

/** The header Cloudflare sets to the visitor's address — ONE value, overwritten
 * at the edge, never appended to. */
const CF_CONNECTING_IP_HEADER = 'cf-connecting-ip'

/**
 * The address a request counts against. `CF-Connecting-IP` is read only when
 * `trustCfConnectingIp` is set (H6: the hub is reachable solely through
 * Caddy, which is reachable solely through Cloudflare), and only when it
 * holds exactly one well-formed IP; anything else — absent, repeated, a
 * list, garbage — falls back to the socket peer rather than hand a caller a
 * free-form rate-limit key.
 */
export function clientIpOf(req: Pick<IncomingMessage, 'headers' | 'socket'>, trustCfConnectingIp: boolean): string {
  const peer = req.socket.remoteAddress ?? 'unknown'
  if (!trustCfConnectingIp) return peer
  const raw = req.headers[CF_CONNECTING_IP_HEADER]
  if (typeof raw !== 'string') return peer
  const value = raw.trim()
  return isIP(value) === 0 ? peer : value
}

const IPV6_GROUPS = 8
const IPV6_PREFIX_GROUPS = 4
const IPV4_MAPPED_PATTERN = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i

/**
 * The key an address is rate-limited under. IPv4: the address itself. IPv6:
 * its /64 — a single subscriber is routinely handed a whole /64, so a limit
 * per IPv6 ADDRESS would let one person rotate through 2^64 fresh windows
 * (and churn the OAuth flow table, whose per-IP limit is its only guard).
 * An IPv4-mapped address counts as the IPv4 address; a zone index is
 * dropped. Anything that is not an IP (`unknown`) passes through unchanged.
 */
export function rateLimitKeyOf(ip: string): string {
  const address = ip.split('%')[0] ?? ''
  if (isIP(address) !== 6) return ip
  const mapped = IPV4_MAPPED_PATTERN.exec(address)
  if (mapped?.[1] !== undefined) return mapped[1]
  const [head = '', tail] = address.split('::')
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':')
  // An embedded IPv4 tail is two groups in one; it only ever sits in the
  // last 32 bits, so miscounting it never moves the /64 prefix read below.
  const zeros = tail === undefined ? [] : new Array<string>(Math.max(0, IPV6_GROUPS - headGroups.length - tailGroups.length)).fill('0')
  const prefix = [...headGroups, ...zeros, ...tailGroups].slice(0, IPV6_PREFIX_GROUPS)
  return `${prefix.map((group) => Number.parseInt(group, 16).toString(16)).join(':')}::/64`
}
