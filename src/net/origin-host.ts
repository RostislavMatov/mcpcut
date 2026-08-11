/**
 * Shared browser-boundary screening for every HTTP front of the plane: the
 * agent-facing `serve` front today, the admin UI in M4. Pure functions over
 * header strings — no I/O, no request objects.
 *
 * This module deliberately lives OUTSIDE `src/transport`: the M4 layering
 * rule allows `src/ui/**` to import `src/net/origin-host.ts` but nothing
 * else from the transport layer, so both fronts share one DNS-rebinding
 * defense without sharing traffic machinery.
 *
 * Both checks defend against the same attack (spec matrix §4.2): a hostile
 * page resolves its own DNS name to 127.0.0.1 and drives the browser at the
 * local plane. `Origin` catches browsers that send it; `Host` catches the
 * rebinding form itself, where the browser believes it is talking to
 * `evil.com` and says so in the Host header.
 */

/**
 * Hostnames considered local. Kept in sync with `LOCALHOST_HOSTNAMES` in
 * `src/transport/http/server-constants.ts` (which cannot import this module
 * being the transport side, nor be imported from here — this module must
 * stay transport-free).
 */
export const LOCALHOST_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '::1', '[::1]']

/** Port implied by a portless `Host` header (the fronts speak plain HTTP). */
const HTTP_DEFAULT_PORT = 80

/**
 * Origin screening (spec MUST in both revisions; matrix §4.2). Absent header
 * → allowed (non-browser agents don't send Origin). Present → must be a
 * localhost origin (`http(s)://localhost|127.0.0.1|[::1]`, any port) or an
 * exact match in `extraAllowed`; anything else the server rejects with 403
 * before doing anything else. `'null'` (opaque origin) is NOT allowed.
 */
export function isOriginAllowed(
  originHeader: string | undefined,
  extraAllowed: readonly string[],
): boolean {
  if (originHeader === undefined) {
    return true
  }
  if (extraAllowed.includes(originHeader)) {
    return true
  }
  let parsed: URL
  try {
    parsed = new URL(originHeader)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }
  return LOCALHOST_HOSTNAMES.includes(parsed.hostname)
}

/** What `isHostAllowed` needs to know about the listening socket. */
export interface HostAllowOptions {
  /** The address the server bound to (as given to `listen`). */
  readonly boundHost: string
  /** The actual bound port (after an ephemeral `listen(0)` resolved). */
  readonly port: number
  /**
   * Exact-match additions to the allowlist — e.g. the public name a
   * reverse proxy forwards in Host. Matched against the raw header value
   * (same exact-match semantics as `isOriginAllowed`'s extra entries), so
   * the entry must include the port if the proxy forwards one.
   */
  readonly extraAllowed: readonly string[]
}

/** A Host header reduced to its two meaningful components. */
interface ParsedHost {
  readonly hostname: string
  readonly port: number
}

/**
 * Parses a `Host` header value strictly: it must be nothing but
 * `hostname[:port]`. Userinfo, a path, a query or a fragment — the forms
 * URL parsing would otherwise quietly absorb — make it invalid.
 */
function parseHostHeader(hostHeader: string): ParsedHost | null {
  let parsed: URL
  try {
    parsed = new URL(`http://${hostHeader}`)
  } catch {
    return null
  }
  const isBareAuthority =
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.pathname === '/' &&
    parsed.search === '' &&
    parsed.hash === ''
  if (!isBareAuthority) {
    return null
  }
  return {
    hostname: parsed.hostname,
    port: parsed.port === '' ? HTTP_DEFAULT_PORT : Number(parsed.port),
  }
}

/**
 * Normalizes a bound host to the hostname form `URL` produces: lowercase,
 * IPv6 literals bracketed (`::1` → `[::1]`).
 */
function normalizeHostname(host: string): string {
  const lowered = host.toLowerCase()
  if (lowered.includes(':') && !lowered.startsWith('[')) {
    return `[${lowered}]`
  }
  return lowered
}

/**
 * Host screening, checked BEFORE authentication. Allowed values are: an
 * exact `extraAllowed` entry, or `hostname:port` where the port equals the
 * bound port (a portless header implies 80) and the hostname is the bound
 * host or any localhost name. Everything else — including a missing header
 * — is refused: a request whose Host names a foreign site is the DNS
 * rebinding shape regardless of what credentials it carries.
 */
export function isHostAllowed(
  hostHeader: string | undefined,
  opts: HostAllowOptions,
): boolean {
  if (hostHeader === undefined) {
    return false
  }
  if (opts.extraAllowed.includes(hostHeader)) {
    return true
  }
  const parsed = parseHostHeader(hostHeader)
  if (parsed === null || parsed.port !== opts.port) {
    return false
  }
  return (
    parsed.hostname === normalizeHostname(opts.boundHost) ||
    LOCALHOST_HOSTNAMES.includes(parsed.hostname)
  )
}
