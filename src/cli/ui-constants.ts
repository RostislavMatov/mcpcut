import { ADMIN_ROLES, ADMIN_TOKEN_ENV_VAR } from '../admin/constants.js'
import { DEFAULT_UI_HOST, DEFAULT_UI_PORT } from '../ui/constants.js'

/**
 * Constants for the two CLI entry points into the admin surface —
 * `mcp-journal ui` (`ui-cmd.ts`) and `mcp-journal admin ...` (`admin-cmd.ts`).
 *
 * Per the per-area convention (`serve-constants.ts` precedent) these live with
 * the commands, not in `src/config.ts`. The bind defaults are NOT redeclared
 * here: `DEFAULT_UI_HOST`/`DEFAULT_UI_PORT` already belong to the UI server
 * (`src/ui/constants.ts`) and are re-exported so the CLI has exactly one
 * source for them.
 */

export { DEFAULT_UI_HOST, DEFAULT_UI_PORT } from '../ui/constants.js'

/** Minimal writable-stream shape both commands need (test doubles satisfy it). */
export interface UiCliWritable {
  write(chunk: string): unknown
}

export interface UiCliIo {
  readonly stdout: UiCliWritable
  readonly stderr: UiCliWritable
}

/** `admin ...` uses the same io shape; aliased so its module reads naturally. */
export type AdminCliIo = UiCliIo

/** Exit code for a refused start (bad flags, unusable port, unreadable store). */
export const EXIT_STARTUP_FAILURE = 1

/** Signals that trigger a graceful shutdown when the caller does not override them. */
export const DEFAULT_UI_SIGNALS: readonly NodeJS.Signals[] = Object.freeze([
  'SIGINT',
  'SIGTERM',
] as NodeJS.Signals[])

/**
 * Name of the admin created on a first start with no `admins.json`. A fixed
 * name (rather than a generated one) keeps the bootstrap line copy-pasteable
 * and the follow-up `admin rotate <name>` obvious.
 */
export const BOOTSTRAP_ADMIN_NAME = 'owner'

/** Printed after any one-time token, on the same stream as the token itself. */
export const TOKEN_ONCE_NOTICE =
  'Save this token now: it cannot be recovered or shown again.\n'

/**
 * Printed after `admin add`/`admin rotate`'s one-time token, on stdout. A
 * supervisor invoking `admin add ... > file` redirects stdout by default,
 * which would otherwise persist a live credential to disk unnoticed.
 */
export const TOKEN_STDOUT_REDIRECT_WARNING =
  "Do not redirect this command's stdout: doing so would persist the token above to disk.\n"

export const UI_USAGE = `Usage:
  mcp-journal ui [--port ${DEFAULT_UI_PORT}] [--host ${DEFAULT_UI_HOST}] [--behind-tls]
                 [--allowed-host <host[:port]>]... [--allowed-origin <origin>]...
                 [--trusted-proxy-header <name>]
                                         Run the local admin UI (approvals queue, quarantine,
                                         servers, agents, journal). Bind loopback and terminate
                                         TLS in front of it; --behind-tls marks cookies Secure.
                                         --trusted-proxy-header keys the login rate limit on a
                                         forwarding header instead of the peer address; enable it
                                         ONLY when the proxy rewrites that header.
`

/**
 * Printed at startup whenever `--trusted-proxy-header` is on. The flag makes
 * the login rate limit trust a value the plane cannot verify: with no proxy in
 * front — or with one that forwards the client's own copy — every caller picks
 * its own bucket and the per-address window stops meaning anything.
 */
export function trustedProxyHeaderNotice(header: string): string {
  return (
    `[ui] --trusted-proxy-header ${header}: login rate limiting now keys on that header, ` +
    'not the peer address. This is safe ONLY if the reverse proxy in front rewrites it; ' +
    'if it passes the client value through, any caller can choose its own rate-limit bucket.'
  )
}

export const ADMIN_USAGE = `Usage:
  admin add <name> --role ${ADMIN_ROLES.join('|')}
                                         Create a named admin; prints its token ONCE
  admin list                             List admins with roles and dates (never hashes)
  admin remove <name>                    Revoke an admin (the last owner cannot be removed)
  admin rotate <name>                    Mint a fresh token; kills that admin's live sessions
  admin rotate <name> --recover          Same, with NO admin token: the way back in when the last
                                         owner lost theirs (recorded as an unattributed recovery)
  admin role <name> <${ADMIN_ROLES.join('|')}>
                                         Change an admin's role (the last owner cannot be demoted)
Every command needs a personal admin token in ${ADMIN_TOKEN_ENV_VAR} (role owner); the FIRST admin
of an empty store needs none, and every change is recorded in the journal under the admin who made it.
`

/**
 * The bootstrap notice for a first start with no admins (phase 6, F6). It
 * names the FILE the one-time token was written to and never the token: under
 * the service manager stderr is `run/ui.log`, and a credential in a log is a
 * credential in every copy, tail and screenshot of that log. Written to
 * stderr (stdout is a daemon's silent channel), exactly once per process.
 */
export function bootstrapNotice(host: string, port: number, name: string, tokenPath: string): string {
  return (
    `[ui] no admins found: created "${name}" with role owner\n` +
    `[ui] its one-time token is in ${tokenPath} (mode 0600); ` +
    `sign in at http://${host}:${port}/login as "${name}"\n` +
    `[ui] the file is deleted after the first sign-in. ` +
    `Rotate the token later with: mcp-journal admin rotate ${name}\n`
  )
}
