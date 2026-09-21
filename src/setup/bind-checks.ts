import { createServer as createNetServer, isIPv4, type Server } from 'node:net'
import { describeBindFailure } from '../cli/bind-failure.js'
import { LOCALHOST_HOSTNAMES } from '../net/origin-host.js'
import type { CheckResult } from './checks.js'
import { CHECK_LISTEN_TIMEOUT_MS, EPHEMERAL_PORT, LOOPBACK_IPV4_PREFIX } from './constants.js'

/**
 * The network half of the `setup` preflight: can each service bind the address
 * it was given, and who else can reach it once it does.
 *
 * Split from `checks.ts` for the file-size budget, along the seam the two
 * halves already had: everything here talks to sockets and hostnames, nothing
 * here touches the data directory. `CheckResult` — the one shape both halves
 * report in — is imported as a TYPE only, so the two modules share a contract
 * without either of them importing the other at run time.
 */

/** A service whose bind address is checked; the two the manager runs. */
export type BindService = 'ui' | 'serve'

const EPHEMERAL_PORT_DETAIL = 'ephemeral'

/** The ADR that owns the plane's HTTP-front threat model; both exposure warnings point at it. */
const EXPOSURE_ADR = 'ADR-0004'

const TERMINATE_TLS_ADVICE =
  "Terminate TLS in front (ui: --behind-tls + --allowed-host; serve: agents' bearer tokens travel in clear otherwise)"

/**
 * `--behind-tls` is a claim this process cannot check: it only changes how the
 * UI treats `X-Forwarded-Proto` and the cookie's `Secure` attribute, and says
 * nothing about whether a terminating proxy actually exists. The bind is still
 * reachable from the network, so the finding stays a `warn` and only the
 * advice changes.
 */
const TLS_DECLARED_ADVICE =
  'TLS is declared (--behind-tls), so make sure a terminating proxy really is in front and --allowed-host names it'

/**
 * Reports whether `host:port` can be bound right now, by binding it and
 * letting go again. Nothing short of a real `listen()` answers the question:
 * a port can be free for `0.0.0.0` and taken for `127.0.0.1`, and privileged
 * ports depend on this process's capabilities, not on the port number.
 *
 * The refusal text comes from `describeBindFailure`, so the sentence an
 * operator reads here is word for word the one the service itself would print
 * on the same failure minutes later.
 */
export async function checkPortFree(
  label: string,
  host: string,
  port: number,
  opts: PortCheckOptions = {},
): Promise<CheckResult> {
  const name = `${label} bind`
  if (port === EPHEMERAL_PORT) {
    return { name, level: 'ok', detail: EPHEMERAL_PORT_DETAIL }
  }

  const target = `${host}:${port}`
  const attempt = await tryListen(host, port, opts)
  if (!attempt.bound) {
    return { name, level: 'fail', detail: describeBindFailure(label, target, attempt.error).trimEnd() }
  }
  return { name, level: 'ok', detail: `${target} free` }
}

/** Seams of the bind attempt: how long to wait, and what to bind with. */
export interface PortCheckOptions {
  readonly timeoutMs?: number
  /** Socket factory; the default is `node:net`'s. Tests inject a stalling one. */
  readonly createServer?: () => Server
}

type ListenAttempt =
  | { readonly bound: true }
  | { readonly bound: false; readonly error: unknown }

/**
 * Binds and immediately closes; never leaves a listening socket behind on any
 * path, timeout included.
 *
 * The timeout is not paranoia about `bind()`: `--ui-host` takes a NAME, and
 * `listen()` resolves it first. A resolver that never answers would otherwise
 * stall the preflight — and with it `setup --yes` — with no output at all.
 */
function tryListen(host: string, port: number, opts: PortCheckOptions): Promise<ListenAttempt> {
  const timeoutMs = opts.timeoutMs ?? CHECK_LISTEN_TIMEOUT_MS
  return new Promise<ListenAttempt>((resolve) => {
    const server = (opts.createServer ?? createNetServer)()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (attempt: ListenAttempt): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(attempt)
    }

    timer = setTimeout(() => {
      settle({ bound: false, error: new Error(`no answer within ${timeoutMs}ms`) })
      // The listen may still be in flight; closing here and again in the
      // callback below is how the socket is released on either ordering.
      server.close(() => undefined)
    }, timeoutMs)

    server.once('error', (error: unknown) => {
      settle({ bound: false, error })
    })
    server.listen(port, host, () => {
      server.close(() => {
        settle({ bound: true })
      })
    })
  })
}

/**
 * Warns when a service binds an address other hosts can reach. This is the
 * one check with no I/O: it is a statement about what the operator asked for,
 * and phase 3's interactive wizard turns the same finding into a confirmation
 * dialog the non-interactive path cannot have.
 */
export function checkBindExposure(
  service: BindService,
  host: string,
  behindTls: boolean,
): CheckResult {
  const name = `${service} exposure`
  if (isLoopbackHost(host)) {
    return { name, level: 'ok', detail: `${host} loopback only` }
  }

  const advice = service === 'ui' && behindTls ? TLS_DECLARED_ADVICE : TERMINATE_TLS_ADVICE
  return {
    name,
    level: 'warn',
    detail: `${service} binds ${host}: reachable from the network. ${advice} — ${EXPOSURE_ADR}`,
  }
}

/**
 * Loopback in the sense that matters here: an address no other host can reach.
 * Built on `LOCALHOST_HOSTNAMES` (`src/net/origin-host.ts`, the single source
 * of the list both HTTP fronts screen against) plus the rest of `127.0.0.0/8`,
 * which that list does not enumerate because a Host header carries a name and
 * a bind flag carries an address.
 *
 * The `/8` half is checked against a real IPv4 LITERAL, never against a string
 * prefix. Security review 2026-09-21 (CRITICAL): `'127.'.startsWith` matched
 * `127.evil.com`, an ordinary DNS name that WHATWG URL parsing leaves as a
 * hostname rather than folding into an address. Every caller that asks this
 * question about an address arriving from OUTSIDE — `--remote`, the
 * `--*-public-url` flags, and `connect --url`, whose owner decision PE8 turns
 * the answer into a refusal — would have called such a host "unreachable from
 * the network" and sent a bearer token to it in clear, with no warning.
 * Addresses written in the decimal, octal and hex forms (`127.1`,
 * `0x7f000001`, `2130706433`) reach this function already normalized to
 * `127.0.0.1` by the URL parser, so nothing is lost by being strict here.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = stripBrackets(host.toLowerCase())
  if (LOCALHOST_HOSTNAMES.includes(bare)) return true
  return isIPv4(bare) && bare.startsWith(LOOPBACK_IPV4_PREFIX)
}

/** `[::1]` is how an IPv6 literal is written in a URL; `--host` takes it either way. */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}
