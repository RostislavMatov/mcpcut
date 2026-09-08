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
