import { isLoopbackHost } from '../../setup/bind-checks.js'

/**
 * The address of a remote console (ADR-0014, plan wave 2 task 1): `--remote
 * <url>` or `MCPCUT_REMOTE`, parsed into the one thing `src/tui/remote/*`
 * needs — an origin to dial and whether it is loopback.
 *
 * A leaf on purpose: it knows nothing about argv syntax (`src/cli.ts` decides
 * whether `--remote` was typed) or about HTTP (`client.ts` dials the origin
 * this module hands back). What it refuses, it refuses the way
 * `setup/public-url.ts` refuses a bad `--*-public-url` — state the flag, the
 * value, and why — because the console has no dialog to explain a typo
 * through and the message ends up on a shell's stderr.
 */

export const REMOTE_URL_ENV_VAR = 'MCPCUT_REMOTE'

/** One remote console address, already validated: nothing left to fail on send. */
export interface RemoteUrl {
  /** `scheme://host[:port]`, exactly as it will be dialed; no trailing slash. */
  readonly origin: string
  readonly hostname: string
  readonly scheme: 'http' | 'https'
  /** An address only this machine can reach — the one case plain http is fine. */
  readonly isLoopback: boolean
}

export type RemoteUrlResult =
  | { readonly ok: true; readonly url: RemoteUrl }
  | { readonly ok: false; readonly message: string }

function refusal(raw: string, reason: string): RemoteUrlResult {
  return { ok: false, message: `--remote "${raw}": ${reason}` }
}

/**
 * Parses one `--remote`/`MCPCUT_REMOTE` value. The rules are RC1's own: an
 * `http`/`https` origin, no userinfo (a token belongs in the header, never in
 * the address), no path/query/hash (the API is served from the root, and a
 * console that silently dropped the rest of a pasted URL would dial the wrong
 * thing without saying so).
 */
export function parseRemoteUrl(raw: string): RemoteUrlResult {
  if (!/^https?:\/\//i.test(raw)) {
    return refusal(raw, raw.includes('://') ? 'must start with http:// or https://' : 'not a URL — it must start with http:// or https://')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return refusal(raw, 'not a URL')
  }
  if (url.hostname === '') return refusal(raw, 'not a URL')
  if (url.username !== '' || url.password !== '') return refusal(raw, 'must not carry credentials')
  if (url.pathname !== '/' && url.pathname !== '') return refusal(raw, 'must not carry a path')
  if (url.search !== '') return refusal(raw, 'must not carry a query')
  if (url.hash !== '') return refusal(raw, 'must not carry a fragment')

  return {
    ok: true,
    url: {
      origin: url.origin,
      hostname: url.hostname,
      scheme: url.protocol === 'https:' ? 'https' : 'http',
      isLoopback: isLoopbackHost(url.hostname),
    },
  }
}

export interface ResolveRemoteUrlOptions {
  /** The `--remote` flag's value, when the argv carried one. */
  readonly flag?: string
  readonly env: NodeJS.ProcessEnv
}

/**
 * The address this invocation means, or `undefined` when it means none at
 * all — the ordinary local console. The flag wins over the environment
 * (RC-decision "flag wins"), and an empty environment value is the same as
 * unset: an operator who cleared `MCPCUT_REMOTE` to `''` in a script meant to
 * turn remote mode off, not to remote-dial an empty string.
 */
export function resolveRemoteUrl(opts: ResolveRemoteUrlOptions): RemoteUrlResult | undefined {
  const raw = opts.flag ?? opts.env[REMOTE_URL_ENV_VAR]
  if (raw === undefined || raw === '') return undefined

  return parseRemoteUrl(raw)
}

/**
 * Whether this address is plain `http` to a host other than this machine —
 * the one case RC4/the `--ui-public-url` precedent print a loud warning for
 * rather than a refusal: a lab box on a trusted network is the operator's
 * call, but the admin token then crosses that network in clear.
 */
export function isPlainHttpToNonLoopback(url: RemoteUrl): boolean {
  return url.scheme === 'http' && !url.isLoopback
}
