import { bootstrapTokenPathFor, consumeBootstrapTokenFile } from '../admin/bootstrap-file.js'
import { ADMIN_TOKEN_ENV_VAR } from '../admin/constants.js'
import { adminFromEnv, type TokenAdmin } from '../cli/admin-token.js'
import type { CliWritable } from '../cli/dispatch-types.js'
import { JOURNAL_DIR } from '../config.js'
import { formatReadableField } from '../journal/format.js'
import type { TokenCell } from './cells.js'
import type { Msg } from './model.js'
import { messageOf } from './runtime-terminal.js'

/**
 * The session half of the effect executor: resolving a token to an admin,
 * signing in, and re-checking that a session still resolves.
 *
 * Split out of `runtime-effects.ts` when the bootstrap token file arrived
 * (phase 6, F6 / Q27) and that file reached its budget. The seam between the
 * two is `SessionDeps`, the three things a sign-in needs — which store, where
 * the token goes, and where a complaint goes — and `EffectDeps` extends it,
 * so the runtime hands one object to both halves.
 *
 * The bootstrap file is the first owner's one-time credential, written by
 * `ui` beside the store (`src/admin/bootstrap-file.ts`). It is removed by
 * the FIRST successful sign-in of any admin, here as in the web UI's login
 * flow, because once someone is in the file is only a copy of a secret that
 * has done its job. Two rules follow. A refused token never touches it: a
 * wrong token must not destroy the credential somebody else still needs.
 * And an unlink that fails is one line of stderr and nothing else — the
 * sign-in answer is what it would have been, since an operator who is in
 * must not be kept out by a file the process could not remove.
 */

/** What resolving a session needs; `EffectDeps` extends this. */
export interface SessionDeps {
  /** Journal directory holding the admin store; defaults to the process-wide one. */
  readonly journalDir?: string
  readonly token: TokenCell
  /**
   * Where a failure to remove the bootstrap token file is reported. Absent
   * in the effect unit harness, where such a failure is simply not said.
   */
  readonly stderr?: CliWritable
}

/** The stderr line's prefix when the bootstrap token file could not be removed. */
export const BOOTSTRAP_FILE_WARNING_PREFIX = '[tui] bootstrap token file: '

/**
 * Resolves a token through the same store lookup the admin CLI and the web UI
 * use. The token is handed over in an environment of its own rather than
 * through the console's `env`, so a stale `MCP_ADMIN_TOKEN` inherited by the
 * console's own process cannot answer for the operator who just typed one.
 */
export async function resolveAdmin(token: string, deps: SessionDeps): Promise<TokenAdmin> {
  return adminFromEnv({
    env: { [ADMIN_TOKEN_ENV_VAR]: token },
    ...(deps.journalDir !== undefined ? { journalDir: deps.journalDir } : {}),
  })
}

/**
 * Signs in: the token is kept only when the store named an admin behind it,
 * and only then is the bootstrap token file consumed.
 */
export async function signIn(token: string, deps: SessionDeps): Promise<Msg> {
  const result = await resolveOrUnreadable(token, deps)
  if (result.kind !== 'ok') return { kind: 'signin-result', result }

  deps.token.set(token)
  await consumeBootstrapFile(deps)
  return { kind: 'signin-result', result }
}

/**
 * `adminFromEnv` rethrows a store fault it does not classify; on the sign-in
 * screen that is a notice to read, not a reason to lose the screen.
 */
async function resolveOrUnreadable(token: string, deps: SessionDeps): Promise<TokenAdmin> {
  try {
    return await resolveAdmin(token, deps)
  } catch (error: unknown) {
    return { kind: 'unreadable', detail: messageOf(error) }
  }
}

/**
 * Removes the bootstrap token file beside the store the sign-in just used —
 * the same directory, so the console never removes another install's file.
 * `absent` is the normal case after the first sign-in and says nothing.
 */
async function consumeBootstrapFile(deps: SessionDeps): Promise<void> {
  const path = bootstrapTokenPathFor(deps.journalDir ?? JOURNAL_DIR)
  const outcome = await consumeBootstrapTokenFile(path)
  if (outcome.kind !== 'failed') return

  deps.stderr?.write(`${BOOTSTRAP_FILE_WARNING_PREFIX}${formatReadableField(outcome.message)}\n`)
}

/**
 * Whether the session still resolves. An unreadable store counts as lost as
 * well: the console cannot attribute the run, and fail-closed is the whole
 * point of re-checking. The sign-in screen it drops back to will report the
 * store's own detail if the fault persists.
 */
export async function isSessionFresh(token: string, deps: SessionDeps): Promise<boolean> {
  try {
    const resolved = await resolveAdmin(token, deps)
    return resolved.kind === 'ok'
  } catch {
    return false
  }
}
