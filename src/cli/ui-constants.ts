import { ADMIN_ROLES } from '../admin/constants.js'
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
                                         Run the local admin UI (approvals queue, quarantine,
                                         servers, agents, journal). Bind loopback and terminate
                                         TLS in front of it; --behind-tls marks cookies Secure.
`

export const ADMIN_USAGE = `Usage:
  admin add <name> --role ${ADMIN_ROLES.join('|')}
                                         Create a named admin; prints its token ONCE
  admin list                             List admins with roles and dates (never hashes)
  admin remove <name>                    Revoke an admin (the last owner cannot be removed)
  admin rotate <name>                    Mint a fresh token; kills that admin's live sessions
  admin role <name> <${ADMIN_ROLES.join('|')}>
                                         Change an admin's role (the last owner cannot be demoted)
`

/**
 * The one-time bootstrap line for a first start with no admins. It carries the
 * plaintext token, so it is written to stderr ONLY (stdout is a daemon's silent
 * channel and is routinely redirected into files or logs by supervisors), and
 * exactly once per process.
 */
export function bootstrapNotice(host: string, port: number, name: string, token: string): string {
  return (
    `[ui] no admins found: created "${name}" with role owner\n` +
    `[ui] sign in at http://${host}:${port}/login as "${name}" with token: ${token}\n` +
    `[ui] ${TOKEN_ONCE_NOTICE.trimEnd()} Rotate it with: mcp-journal admin rotate ${name}\n`
  )
}
