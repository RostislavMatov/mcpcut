import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns'
import { Agent as HttpsAgent } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { classifyAddress, type AddressRefusal } from './address-class.js'
import { UpstreamAddressRefusedError } from './upstream-guard-errors.js'

export {
  UPSTREAM_ADDRESS_REFUSED_CODE,
  UpstreamAddressRefusedError,
  type AddressSource,
  type UpstreamRefusal,
} from './upstream-guard-errors.js'

/**
 * Tenant-mode SSRF guard (ADR-0017 T4): a hosted install dials only public
 * `https` upstreams. Two halves, because Node resolves in two different ways:
 *
 * - `checkUrl` — BEFORE every request. It refuses a non-`https` scheme and an
 *   IP-literal host that is not public. It exists because `net.connect` never
 *   calls `lookup` for a literal, so the other half would not see one.
 * - `lookup` — passed to `http(s).request` as the socket's own resolver. The
 *   answer is checked inside the very resolution the socket dials, so there is
 *   no gap between "checked" and "connected" for DNS rebinding to use. Strict:
 *   one non-public address anywhere in the answer refuses the whole name (a
 *   later happy-eyeballs attempt could otherwise reach it).
 *
 * - `agent` — the guard's OWN keep-alive https socket pool, built around that
 *   `lookup` (security review M1). A pooled socket is reused without resolving
 *   again, so a guarded request must never draw from the process-wide
 *   `https.globalAgent`: a socket an unguarded client opened there would carry
 *   it to an address the guard never checked. Every socket in this pool was
 *   opened through the guard's `lookup` — `https.Agent` hands its own options,
 *   `lookup` included, to `createConnection`, and they win over the request's.
 *
 * Only a refusal is a guard error; a failed resolution goes to the callback
 * exactly as the resolver produced it, so the client reports it the way it
 * always has.
 */

/** The resolver the guard wraps: `dns.lookup` with `all: true`, callback form. */
export type ResolveAllFunction = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: readonly LookupAddress[]) => void,
) => void

export interface UpstreamGuard {
  /** Throws `UpstreamAddressRefusedError` for a non-https URL or a non-public literal host. */
  checkUrl(url: URL): void
  /** A `lookup` for `http(s).request` options that hands out only public addresses. */
  readonly lookup: LookupFunction
  /** A keep-alive `https.Agent` whose every socket is resolved through `lookup`. */
  readonly agent: HttpsAgent
}

export interface UpstreamGuardDeps {
  /** Replaces the system resolver (tests). Defaults to `dns.lookup`. */
  readonly lookup?: ResolveAllFunction
}

/**
 * Pool settings mirror Node's own `https.globalAgent` (Node 19+), so moving a
 * guarded request off it changes where its socket comes from and nothing else:
 * an idle pooled socket is closed after `GUARD_AGENT_IDLE_TIMEOUT_MS` and is
 * unref'd meanwhile, so it neither lingers nor holds the process open. That is
 * why the agent is never `destroy()`-ed: one guard serves every client a
 * prepared upstream opens (reconnects included), so no single client's
 * `close()` owns it.
 */
const GUARD_AGENT_IDLE_TIMEOUT_MS = 5_000

const systemResolveAll: ResolveAllFunction = (hostname, options, callback) => {
  dnsLookup(hostname, options, (error, addresses) => callback(error, addresses ?? []))
}

export function createUpstreamGuard(deps: UpstreamGuardDeps = {}): UpstreamGuard {
  const resolveAll = deps.lookup ?? systemResolveAll
  const lookup = guardedLookup(resolveAll)
  const agent = new HttpsAgent({
    keepAlive: true,
    scheduling: 'lifo',
    timeout: GUARD_AGENT_IDLE_TIMEOUT_MS,
    lookup,
  })
  return Object.freeze({ checkUrl, lookup, agent })
}

function checkUrl(url: URL): void {
  const host = withoutBrackets(url.hostname)
  if (url.protocol !== 'https:') throw new UpstreamAddressRefusedError(host, 'scheme')
  // An IP literal that IS a refused address reports THAT reason, port
  // notwithstanding — a loopback/private/etc. literal is refused for what it
  // is, whatever port it names. A DNS name (or a literal that passes the
  // address check) falls through to the port rule below.
  if (isIP(host) !== 0) {
    const verdict = classifyAddress(host)
    if (verdict.kind === 'refused') {
      throw new UpstreamAddressRefusedError(host, verdict.reason, 'literal')
    }
  }
  // O8 (tenant-orchestrator plan): reaches only port 443. The URL parser
  // normalizes an explicit `:443` on `https:` away, so a non-empty `.port`
  // here always names an explicit, non-default port.
  if (url.port !== '') throw new UpstreamAddressRefusedError(host, 'port')
}

function guardedLookup(resolveAll: ResolveAllFunction): LookupFunction {
  return (hostname, options, callback) => {
    const onAnswer = (
      error: NodeJS.ErrnoException | null,
      addresses: readonly LookupAddress[],
    ): void => {
      if (error !== null) return callback(error, [])
      const [first] = addresses
      if (first === undefined) return callback(notFound(hostname), [])
      const reason = firstRefusal(addresses)
      if (reason !== undefined) {
        return callback(new UpstreamAddressRefusedError(hostname, reason), [])
      }
      deliver(first, addresses, options, callback)
    }
    try {
      resolveAll(hostname, { ...options, all: true }, onAnswer)
    } catch (error: unknown) {
      callback(asErrno(error), [])
    }
  }
}

/**
 * The first reason to refuse in a DNS answer. A resolver entry that is not an
 * IP address at all (family 0 — a broken name service) is refused too: the
 * guard fails closed on anything it cannot classify.
 */
function firstRefusal(addresses: readonly LookupAddress[]): AddressRefusal | undefined {
  for (const { address } of addresses) {
    if (isIP(address) === 0) return 'reserved'
    const verdict = classifyAddress(address)
    if (verdict.kind === 'refused') return verdict.reason
  }
  return undefined
}

/** Every checked address for `all: true` (a fresh array), else the first one. */
function deliver(
  first: LookupAddress,
  addresses: readonly LookupAddress[],
  options: LookupOptions,
  callback: Parameters<LookupFunction>[2],
): void {
  if (options.all === true) {
    callback(null, addresses.map((entry) => ({ address: entry.address, family: entry.family })))
    return
  }
  callback(null, first.address, first.family)
}

/** An empty answer is a failed resolution, reported the way getaddrinfo would. */
function notFound(hostname: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
    code: 'ENOTFOUND',
    hostname,
  })
}

function asErrno(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error : new Error(String(error))
}

/** `URL.hostname` keeps the brackets of an IPv6 literal (`[::1]`). */
function withoutBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}
