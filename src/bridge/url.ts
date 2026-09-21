import { isLoopbackHost } from '../setup/bind-checks.js'
import { BRIDGE_POOL_PATH } from './constants.js'

/**
 * The address `mcpcut connect --url <address>` dials (ADR-0015, owner
 * decisions PE5 and PE8).
 *
 * A leaf, like `tui/remote/url.ts` which it mirrors: it knows nothing about
 * argv syntax (`cli/connect-bridge-cmd.ts` decides what was typed) and
 * nothing about HTTP (`transport/http/client.ts` dials what this hands
 * back). Two rules differ from the console's address, both of them owner
 * decisions:
 *
 *  - a PATH is allowed. `/agents/<agent>/servers/<server>` is the per-server
 *    address of PE4 and stays supported; the pool endpoint of PE5 is what a
 *    bare origin means, appended here rather than typed there.
 *  - plain `http` to another host is REFUSED rather than warned about (PE8).
 *    The console's `--remote` warns because an operator is watching; here an
 *    agent token crosses that network on EVERY request, unattended, and the
 *    flag that takes the refusal back is a visible line in the client config.
 *
 * What it refuses, it refuses the way `parseRemoteUrl` does — state the flag,
 * the value and the reason — with one exception: an address carrying
 * userinfo is never echoed back, because that is precisely where a pasted
 * token would be, and this message lands on a stderr an MCP client logs.
 */

/** One bridge address, already validated: nothing left to fail on send. */
export interface BridgeUrl {
  /** The full URL every message is POSTed to. */
  readonly endpoint: string
  /** `scheme://host[:port]` — what operator-facing messages name, never the path. */
  readonly origin: string
  readonly scheme: 'http' | 'https'
  /** An address only this machine can reach — the one case plain http is fine. */
  readonly isLoopback: boolean
  /** No path was given, so `BRIDGE_POOL_PATH` was appended (PE5). */
  readonly isPoolAddress: boolean
}

export type BridgeUrlResult =
  | { readonly ok: true; readonly url: BridgeUrl }
  | { readonly ok: false; readonly message: string }

/** Longest echo of an operator's value; past this a refusal would fill the screen. */
const MAX_ECHOED_VALUE = 120

/**
 * Renders a value for a message that lands on a terminal's stderr — and, from
 * there, in the log file an MCP client keeps. Control characters are dropped
 * rather than replayed: argv can carry terminal escapes, and a refusal that
 * replayed them could erase or rewrite the very line it is trying to show
 * (the `H2` precedent, where a server's tool names were displayed without
 * invisible and bidi characters).
 */
function displayable(raw: string): string {
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e]/g, '')
  return clean.length > MAX_ECHOED_VALUE ? `${clean.slice(0, MAX_ECHOED_VALUE)}…` : clean
}

/**
 * A refusal that quotes the operator's own value back. Used only where the
 * value cannot hold a secret: a missing or wrong scheme, and a string that is
 * not a URL at all. An address carrying userinfo, a query or a fragment goes
 * through `hostOnlyRefusal` instead — those are exactly where a token lands.
 */
function refusal(raw: string, reason: string): BridgeUrlResult {
  return { ok: false, message: `--url "${displayable(raw)}": ${reason}\n` }
}

/** A refusal that names only the host, for a value that may embed a secret. */
function hostOnlyRefusal(host: string, reason: string): BridgeUrlResult {
  return { ok: false, message: `--url (address of ${displayable(host)}): ${reason}\n` }
}

/**
 * The endpoint a parsed URL means: its own path, minus one trailing slash,
 * or the pool path when it carried none. The path is otherwise passed
 * through byte for byte — the HTTP front does not decode its own routes, so
 * normalizing here would dial something the operator did not write.
 */
function endpointOf(url: URL): { readonly endpoint: string; readonly isPoolAddress: boolean } {
  const path = url.pathname
  if (path === '' || path === '/') {
    return { endpoint: `${url.origin}${BRIDGE_POOL_PATH}`, isPoolAddress: true }
  }
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  return { endpoint: `${url.origin}${trimmed}`, isPoolAddress: false }
}

/**
 * Parses one `--url` value. A scheme is REQUIRED and never guessed: silently
 * reading `plane.example:8090` as `https://` would be a guess, and reading it
 * as `http://` would be a guess that leaks the token.
 */
export function parseBridgeUrl(raw: string): BridgeUrlResult {
  if (!/^https?:\/\//i.test(raw)) {
    return refusal(
      raw,
      raw.includes('://')
        ? 'must start with http:// or https://'
        : 'not a URL — it must start with http:// or https://',
    )
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return refusal(raw, 'not a URL')
  }
  if (url.hostname === '') return refusal(raw, 'not a URL')
  if (url.username !== '' || url.password !== '') {
    return hostOnlyRefusal(
      url.hostname,
      `must not carry credentials — the agent token belongs in the environment, in MCP_AGENT_TOKEN`,
    )
  }
  // Host-only, like the userinfo refusal above and for the same reason: a
  // query or a fragment is where an OAuth-shaped secret gets pasted, and the
  // argv screen in `connect-bridge-cmd.ts` knows only this project's own
  // token prefix.
  if (url.search !== '') {
    return hostOnlyRefusal(url.hostname, 'must not carry a query — the address alone is the endpoint')
  }
  if (url.hash !== '') {
    return hostOnlyRefusal(url.hostname, 'must not carry a fragment — the address alone is the endpoint')
  }

  const { endpoint, isPoolAddress } = endpointOf(url)
  return {
    ok: true,
    url: {
      endpoint,
      origin: url.origin,
      scheme: url.protocol === 'https:' ? 'https' : 'http',
      isLoopback: isLoopbackHost(url.hostname),
      isPoolAddress,
    },
  }
}

/** What this scheme earns: nothing, a loud warning, or a refusal (PE8). */
export type SchemeVerdict = 'ok' | 'warn' | 'refuse'

/**
 * Judges the scheme. `https`, and plain `http` to this machine, are fine
 * unconditionally; plain `http` to any other host is a refusal that
 * `--allow-http` downgrades to a warning — never to silence.
 */
export function checkBridgeScheme(url: BridgeUrl, allowHttp: boolean): SchemeVerdict {
  if (url.scheme === 'https' || url.isLoopback) return 'ok'
  return allowHttp ? 'warn' : 'refuse'
}
