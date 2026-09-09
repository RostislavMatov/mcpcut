import { ADMIN_TOKEN_ENV_VAR } from '../admin/constants.js'
import type { DispatchOptions } from '../cli/dispatch-types.js'

/**
 * The only place the session token reaches the dispatcher (plan phase 2, task
 * 11).
 *
 * The console signs an operator in once and then runs commands on their
 * behalf, and every one of those commands resolves the operator through
 * `MCP_ADMIN_TOKEN` in its own `env` seam. The token therefore travels in an
 * environment object handed to those seams — never in argv, where it would
 * sit in the command line the output panel prints back, and never in the
 * model, which is what a frame is rendered from (ADR-0004: the token is
 * attribution, and it stays out of anything anybody can read off a screen).
 *
 * The seam list is closed and exported. Only the commands whose `env` means
 * "the admin running this" are on it: `wrap`, `connect`, `serve` and `ui`
 * carry an environment with a different meaning (an agent's token, a daemon's
 * whole environment). Handing the session token to those would be a quiet
 * privilege transplant, so the list is a decision recorded in code rather
 * than a loop over the option keys.
 *
 * `admin` joined the list on 2026-09-06, when the owner decided that
 * `admin add|list|rotate|role|remove` must be gated and journaled like
 * `vault *` and `agent *`: the console signs an owner in, and the CLI
 * re-checks that owner's token through this seam, so an admin created from
 * the console is recorded under the name of the operator who created it.
 *
 * Six more joined on 2026-09-08 with owner decision Q17: `quarantine`
 * (`approve|reject` are now `operator`-gated and journalled) and `prune`
 * (`--yes` is `owner`-gated) need the token to be allowed to act at all,
 * while `keygen`, `backup`, `migrate` and `verify --sign` stay ungated and
 * use it only to put the operator's NAME on the record they leave. Without
 * these seams a release approved from the console would be refused, and the
 * evidence commands would record nobody — the console signs an operator in
 * precisely so that what it runs is attributable to them.
 */

/** The command seams whose `env` resolves `MCP_ADMIN_TOKEN` for the admin running it. */
export const SESSION_ENV_SEAMS = [
  'approvals',
  'server',
  'agent',
  'group',
  'vault',
  'policy',
  'services',
  'setup',
  'admin',
  'quarantine',
  'prune',
  'keygen',
  'backup',
  'migrate',
  'verify',
] as const

/**
 * The caller's dispatch options with `env` on every seam of
 * `SESSION_ENV_SEAMS`, and nothing else changed. Written out seam by seam,
 * the way `accessWriteOptionsOf` lays out the vault's: a typed spread keeps
 * each seam's own fields (`services.manager`, `admin.journalDir`) and lets the
 * compiler refuse a seam that has no `env` to set.
 *
 * The environment is whatever the caller means by it. `withSessionToken`
 * below means "the signed-in operator"; the first-run wizard (phase 3) means
 * the console's own environment with no token in it at all, because the
 * install it is about to create has no admin yet — and `setup` mints one.
 * Passing the console's `MCPCUT_CONFIG` down this way is the point: `setup`
 * writes the config there and `start` reads it back from the same place.
 */
export function withSeamEnv(base: DispatchOptions, env: NodeJS.ProcessEnv): DispatchOptions {
  return {
    ...base,
    approvals: { ...base.approvals, env },
    server: { ...base.server, env },
    agent: { ...base.agent, env },
    group: { ...base.group, env },
    vault: { ...base.vault, env },
    policy: { ...base.policy, env },
    services: { ...base.services, env },
    setup: { ...base.setup, env },
    admin: { ...base.admin, env },
    quarantine: { ...base.quarantine, env },
    prune: { ...base.prune, env },
    keygen: { ...base.keygen, env },
    backup: { ...base.backup, env },
    migrate: { ...base.migrate, env },
    verify: { ...base.verify, env },
  }
}

/**
 * The same seams, with an environment that carries the session's token — the
 * name the console's own runs go by, so the security property this module is
 * read for stays greppable.
 */
export function withSessionToken(base: DispatchOptions, env: NodeJS.ProcessEnv): DispatchOptions {
  return withSeamEnv(base, env)
}

/** The process environment plus the session's token, as the seams above expect it. */
export function sessionEnvOf(base: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  return { ...base, [ADMIN_TOKEN_ENV_VAR]: token }
}

/**
 * The same environment with the admin token taken OUT — what a command run
 * with no session gets.
 *
 * The console is a place an operator signs in AT, and the shell it was started
 * from may well have `MCP_ADMIN_TOKEN` exported. Handing that on is not
 * "passing the operator's environment through": it would let a command the
 * console asks for on its own (the sign-in screen's `status --json`, plan P3)
 * act as whoever that token names before anybody has signed in — and the
 * console would have chosen an identity nobody typed.
 */
export function withoutAdminToken(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { [ADMIN_TOKEN_ENV_VAR]: _removed, ...rest } = base
  return rest
}

/**
 * The caller's options with `vault set` reading its value from `secret`
 * instead of the process stdin (mcpcut phase 4, task 8).
 *
 * The second thing this module keeps off a screen. A secret typed into the
 * console must reach the vault and nothing else: not argv, which the output
 * pane prints back verbatim, and not the model, which is what a frame is
 * rendered from. `vault set` already reads its value from stdin behind an
 * injectable seam, so the value travels in a closure the CLI calls once —
 * the console's process has no stdin to pipe (the terminal is in raw mode and
 * belongs to the console itself).
 *
 * Written as a typed spread, like `withSeamEnv` above: the seam keeps its own
 * fields, so the environment that carries the session token — `vault set` is
 * owner-gated and journaled — survives being composed with this one.
 */
export function withSecretInput(base: DispatchOptions, secret: string): DispatchOptions {
  return { ...base, vault: { ...base.vault, readSecretInput: () => Promise.resolve(secret) } }
}
