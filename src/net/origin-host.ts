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
 * Hostnames considered local — the single source of the list. The transport
 * side re-exports it (`src/transport/http/server-constants.ts`): transport
 * already imports this module for the screening functions, while this module
 * must stay transport-free, so the dependency can only point this way.
 */
export const LOCALHOST_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '::1', '[::1]']

/** Port implied by a portless `Host` header (the fronts speak plain HTTP). */
const HTTP_DEFAULT_PORT = 80

/**
 * The literal value `'null'` is the wire form of an opaque `Origin` header —
 * what a browser sends from a sandboxed iframe, a `data:` URL or a redirected
 * request with no origin of its own. `isOriginAllowed` already refuses it as
 * a HEADER value; this guards the other end of the same rule, the CLI flag
 * that seeds `extraAllowed`. Without it, `--allowed-origin null` would put
 * the exact string `'null'` into `extraAllowed`, and the `extraAllowed.includes`
 * check in `isOriginAllowed` would then re-admit the opaque origin it exists
 * to reject — so both CLI entry points reject this flag value up front,
 * before it ever reaches the allowlist.
 */
export function isRejectedOriginFlagValue(value: string): boolean {
  return value === 'null'
}

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
 * URL parsing would otherwise quietly absorb — make it invalid. A raw `/`
 * anywhere (URL parsing silently drops a trailing one) and a trailing `:`
 * (an empty port `URL` treats as no port) are refused up front.
 */
function parseHostHeader(hostHeader: string): ParsedHost | null {
  if (hostHeader.includes('/') || hostHeader.endsWith(':')) {
    return null
  }
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
 * Normalizes a bound host to the CANONICAL hostname form `URL` produces:
 * lowercase, IPv6 literals bracketed and compressed through the same parser
 * that canonicalizes the Host header side (`fd00:0:0:0:0:0:0:5` ≡
 * `[fd00::5]`) — two different spellings of one address must not defeat the
 * comparison. An IPv6 literal `URL` cannot parse falls back to the plain
 * bracketed-lowercase form (which then simply never matches a canonical
 * header — fail closed).
 */
function normalizeHostname(host: string): string {
  const lowered = host.toLowerCase()
  if (!lowered.includes(':')) {
    return lowered
  }
  const bare =
    lowered.startsWith('[') && lowered.endsWith(']') ? lowered.slice(1, -1) : lowered
  try {
    return new URL(`http://[${bare}]`).hostname
  } catch {
    return lowered.startsWith('[') ? lowered : `[${lowered}]`
  }
}

/**
 * Wildcard bind addresses. A server bound to one of these listens on every
 * interface, so the bound "host" is not a meaningful Host-header value and
 * must not enter the comparison: `Host: 0.0.0.0:port` is an alias for
 * loopback on several stacks (a rebinding-friendly shape), while legitimate
 * remote clients arrive with a real name that only `extraAllowed` can admit.
 */
const WILDCARD_BIND_HOSTNAMES: readonly string[] = ['0.0.0.0', '[::]']

/** True when `host` (as given to `listen`) binds every interface. */
export function isWildcardBindHost(host: string): boolean {
  return WILDCARD_BIND_HOSTNAMES.includes(normalizeHostname(host))
}

/**
 * Host screening, checked BEFORE authentication. Allowed values are: an
 * `extraAllowed` entry (compared case-insensitively — RFC 9110 §4.2.3 makes
 * host names case-insensitive; ports and the rest must still match exactly),
 * or `hostname:port` where the port equals the bound port (a portless header
 * implies 80) and the hostname is the bound host or any localhost name. A
 * wildcard bind (`0.0.0.0`, `::`) contributes NO hostname of its own: only
 * localhost names and `extraAllowed` pass. Everything else — including a
 * missing header — is refused: a request whose Host names a foreign site is
 * the DNS rebinding shape regardless of what credentials it carries.
 */
export function isHostAllowed(
  hostHeader: string | undefined,
  opts: HostAllowOptions,
): boolean {
  if (hostHeader === undefined) {
    return false
  }
  const headerLowered = hostHeader.toLowerCase()
  if (opts.extraAllowed.some((entry) => entry.toLowerCase() === headerLowered)) {
    return true
  }
  const parsed = parseHostHeader(hostHeader)
  if (parsed === null || parsed.port !== opts.port) {
    return false
  }
  if (LOCALHOST_HOSTNAMES.includes(parsed.hostname)) {
    return true
  }
  if (isWildcardBindHost(opts.boundHost)) {
    return false
  }
  return parsed.hostname === normalizeHostname(opts.boundHost)
}
