import { formatReadableField } from '../journal/format.js'
import { isWildcardBindHost } from '../net/origin-host.js'
import { isLoopbackHost } from './bind-checks.js'
import type { CheckResult } from './checks.js'

/**
 * `--ui-public-url` / `--serve-public-url` (owner decision 2026-09-19): the
 * address an operator will actually type — `http://203.0.113.7:8091`,
 * `https://mcp.example.com` — turned into the settings an HTTP front needs to
 * answer it.
 *
 * Without this an install reached by IP fails in two steps the operator has
 * no way to foresee: every request is a 403 until `--allowed-host` names the
 * address (the DNS-rebinding screen admits only localhost names), and once it
 * does the pages open but every form is still a 403 until `--allowed-origin`
 * names it too. Three flags to know about, against one fact the operator
 * already knows.
 *
 * What is derived, and what is deliberately not:
 *  - the Host entry and the Origin, spelled the way a browser spells them — a
 *    default port is dropped from both, which is what WHATWG `URL` does;
 *  - the BIND, but only for plain `http` to a non-loopback address over a
 *    loopback bind nobody typed: that URL cannot work otherwise. `https`
 *    means a TLS proxy in front, which normally sits on the same host and
 *    dials loopback, so the bind is left alone;
 *  - NOT the port: under Docker and behind a proxy the published port and the
 *    listening port are different numbers on purpose.
 */

export interface PublicUrl {
  readonly scheme: 'http' | 'https'
  /** `host[:port]` exactly as the `Host` header will carry it. */
  readonly hostEntry: string
  /** `scheme://host[:port]` exactly as the `Origin` header will carry it. */
  readonly origin: string
  readonly isLoopback: boolean
  readonly isIpv6: boolean
}

export type PublicUrlResult =
  | { readonly ok: true; readonly url: PublicUrl }
  | { readonly ok: false; readonly message: string }

const IPV4_WILDCARD = '0.0.0.0'
const IPV6_WILDCARD = '::'

function refusal(flag: string, raw: string, reason: string): PublicUrlResult {
  return { ok: false, message: `${flag} "${formatReadableField(raw)}": ${reason}` }
}

/** Parses one public address; every refusal names the flag and says why. */
export function parsePublicUrl(flag: string, raw: string): PublicUrlResult {
  if (!/^https?:\/\//i.test(raw)) {
    return refusal(flag, raw, raw.includes('://') ? 'must start with http:// or https://' : 'not a URL — it must start with http:// or https://')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return refusal(flag, raw, 'not a URL')
  }
  if (url.hostname === '') return refusal(flag, raw, 'not a URL')
  // `0.0.0.0`/`::` is where a service LISTENS; nobody connects to it from
  // outside. Accepted, it would open the bind AND allow-list `Host: 0.0.0.0`,
  // which several stacks route to this very host — an entry the rebinding
  // screen exists to refuse.
  if (isWildcardBindHost(url.hostname)) {
    return refusal(flag, raw, 'is a wildcard bind address — give the address you will actually connect to')
  }
  if (url.username !== '' || url.password !== '') return refusal(flag, raw, 'must not carry credentials')
  if (url.pathname !== '/' && url.pathname !== '') return refusal(flag, raw, 'must not carry a path — the console is served from the root')
  if (url.search !== '') return refusal(flag, raw, 'must not carry a query')
  if (url.hash !== '') return refusal(flag, raw, 'must not carry a fragment')

  return {
    ok: true,
    url: {
      scheme: url.protocol === 'https:' ? 'https' : 'http',
      hostEntry: url.host,
      origin: url.origin,
      isLoopback: isLoopbackHost(url.hostname),
      isIpv6: url.hostname.startsWith('['),
    },
  }
}

/** The part of a service's config a public address touches. */
export interface PublicUrlTarget {
  readonly host: string
  readonly allowedHosts?: readonly string[] | undefined
  readonly allowedOrigins?: readonly string[] | undefined
}

export interface ApplyPublicUrlOptions {
  /** `--ui-host`/`--serve-host` was typed in the same run: it is never overruled. */
  readonly isHostTyped: boolean
  /** Browsers send an Origin; agents do not, so `serve` takes the Host entry only. */
  readonly withOrigin: boolean
}

function withEntry(list: readonly string[] | undefined, entry: string): string[] {
  const current = list ?? []
  return current.includes(entry) ? [...current] : [...current, entry]
}

/** True when this address can only work if the bind is opened to the network. */
function needsNetworkBind(target: PublicUrlTarget, url: PublicUrl, options: ApplyPublicUrlOptions): boolean {
  return url.scheme === 'http' && !url.isLoopback && !options.isHostTyped && isLoopbackHost(target.host)
}

/** The same config with the address allowed — and the bind opened when nothing else could work. */
export function applyPublicUrl<T extends PublicUrlTarget>(
  target: T,
  url: PublicUrl,
  options: ApplyPublicUrlOptions,
): T & { readonly allowedHosts: string[] } {
  return {
    ...target,
    ...(needsNetworkBind(target, url, options) ? { host: url.isIpv6 ? IPV6_WILDCARD : IPV4_WILDCARD } : {}),
    allowedHosts: withEntry(target.allowedHosts, url.hostEntry),
    ...(options.withOrigin ? { allowedOrigins: withEntry(target.allowedOrigins, url.origin) } : {}),
  }
}

/** What crosses the network unencrypted on each front. */
const CLEAR_TEXT_SUBJECT = { ui: 'admin tokens and session cookies', serve: 'agent keys and every tool call' } as const

/**
 * The address as a line of the `setup` transcript. Plain `http` to a public
 * address is a WARNING, never a refusal — a lab VPS is the operator's call,
 * and `--yes` has no dialog to confirm through — but it says exactly what is
 * exposed and the two ways out, because "it works" is what the operator will
 * see next and nothing on the page will mention it again.
 */
export function checkPublicUrl(
  service: 'ui' | 'serve',
  url: PublicUrl,
  allowedHosts: readonly string[] = [],
): CheckResult {
  const name = `${service} address`
  // An address is ADDED, never swapped: a second one may be just as real (a
  // name beside an IP). So the whole list is said out loud, and an entry left
  // behind by a move is something the operator sees instead of inherits.
  const answersTo = allowedHosts.length > 1 ? ` (Host allow-list now: ${allowedHosts.join(', ')})` : ''
  if (url.scheme === 'https' || url.isLoopback) {
    return { name, level: 'ok', detail: `answers at ${url.origin}${answersTo}` }
  }
  return {
    name,
    level: 'warn',
    detail:
      `answers at ${url.origin}${answersTo} over plain http: ${CLEAR_TEXT_SUBJECT[service]} cross the network in clear text. ` +
      `Put TLS in front and pass the https:// address instead, or leave the port unpublished and use ` +
      `"ssh -L <port>:127.0.0.1:<port> <user>@<host>"`,
  }
}
