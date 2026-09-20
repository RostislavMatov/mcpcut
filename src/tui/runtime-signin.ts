import { setupCodePathFor, consumeSetupCodeFile } from '../admin/setup-code-file.js'
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
 * Split out of `runtime-effects.ts` when the first-run file arrived
 * (phase 6, F6 / Q27) and that file reached its budget. The seam between the
 * two is `SessionDeps`, the three things a sign-in needs — which store, where
 * the token goes, and where a complaint goes — and `EffectDeps` extends it,
 * so the runtime hands one object to both halves.
 *
 * The setup code file is the first run's one-time secret, written by `ui`
 * beside the store (`src/admin/setup-code-file.ts`). It is removed by the
 * FIRST successful sign-in of any admin, here as in the web UI's login flow,
 * because a sign-in proves an admin exists and the code opens nothing from
 * then on. Two rules follow. A refused token never touches it: a wrong token
 * must not destroy the code somebody at the `/setup` page still needs.
 * And an unlink that fails is one line of stderr and nothing else — the
 * sign-in answer is what it would have been, since an operator who is in
 * must not be kept out by a file the process could not remove.
 *
 * `resolve` is the remote console's seam (ADR-0014): when present it stands
 * in for `resolveAdmin`'s local store lookup entirely — a `whoami` call
 * instead of a file read — and the setup code file is skipped as well,
 * because that file lives beside the SERVER's store, on a machine this
 * process may never have touched. A local console never sets it, so every
 * caller written before wave 2 keeps its meaning.
 *
 * `isFresh` is a SEPARATE seam, added for the same ADR's security review
 * (HIGH: a network blip signing an operator out). `isSessionFresh` used to
 * mean "ask `resolve`/the store again", which for a remote console is a
 * `whoami` round trip run before every single `run`/`poll`/`refresh-services`
 * — doubling every request, and turning ANY failure of that pre-check
 * (timeout, DNS, a proxy hiccup) into a false `SESSION_LOST`, even though the
 * token itself is perfectly valid and the operator's own request never
 * happened. Remotely there is no such thing as a freshness pre-check request:
 * the run authenticates itself against the server, and `isFresh` answers from
 * a flag the caller already knows the answer to (`src/cli/tui-remote.ts`'s
 * revoked-flag cell) rather than asking anyone. A local console never sets
 * it, so `isSessionFresh` keeps asking `resolveAdmin` exactly as before.
 */

/** What resolving a session needs; `EffectDeps` extends this. */
export interface SessionDeps {
  /** Journal directory holding the admin store; defaults to the process-wide one. */
  readonly journalDir?: string
  readonly token: TokenCell
  /**
   * Where a failure to remove the setup code file is reported. Absent
   * in the effect unit harness, where such a failure is simply not said.
   */
  readonly stderr?: CliWritable
  /**
   * Resolves a token over the network instead of the local admin store
   * (ADR-0014, `src/tui/remote/dispatch.ts`'s sibling seam). Present only for
   * a console opened with `--remote`/`MCPCUT_REMOTE`.
   */
  readonly resolve?: (token: string) => Promise<TokenAdmin>
  /**
   * Answers session freshness directly, without a network round trip. Present
   * only for a console opened with `--remote`/`MCPCUT_REMOTE` — see the module
   * doc above. When present, `isSessionFresh` uses ONLY this and never calls
   * `resolve`/the local store at all.
   */
  readonly isFresh?: (token: string) => Promise<boolean> | boolean
}

/** The stderr line's prefix when the setup code file could not be removed. */
export const SETUP_CODE_FILE_WARNING_PREFIX = '[tui] setup code file: '

/**
 * Resolves a token through the same store lookup the admin CLI and the web UI
 * use. The token is handed over in an environment of its own rather than
 * through the console's `env`, so a stale `MCP_ADMIN_TOKEN` inherited by the
 * console's own process cannot answer for the operator who just typed one.
 */
export async function resolveAdmin(token: string, deps: SessionDeps): Promise<TokenAdmin> {
  if (deps.resolve !== undefined) return deps.resolve(token)

  return adminFromEnv({
    env: { [ADMIN_TOKEN_ENV_VAR]: token },
    ...(deps.journalDir !== undefined ? { journalDir: deps.journalDir } : {}),
  })
}

/**
 * Signs in: the token is kept only when the store named an admin behind it,
 * and only then is the setup code file consumed — and only for a LOCAL
 * console (`deps.resolve` absent). A remote console's code file, if any, is
 * on the server the `POST setup` call already told to forget it; touching a
 * file beside a store this process never opened would be reading a stranger's
 * install by the coincidence of a shared default path.
 */
export async function signIn(token: string, deps: SessionDeps): Promise<Msg> {
  const result = await resolveOrUnreadable(token, deps)
  if (result.kind !== 'ok') return { kind: 'signin-result', result }

  deps.token.set(token)
  if (deps.resolve === undefined) await removeSetupCodeFile(deps)
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
 * Removes the setup code file beside the store the sign-in just used —
 * the same directory, so the console never removes another install's file.
 * `absent` is the normal case after the first sign-in and says nothing.
 */
async function removeSetupCodeFile(deps: SessionDeps): Promise<void> {
  const path = setupCodePathFor(deps.journalDir ?? JOURNAL_DIR)
  const outcome = await consumeSetupCodeFile(path)
  if (outcome.kind !== 'failed') return

  deps.stderr?.write(`${SETUP_CODE_FILE_WARNING_PREFIX}${formatReadableField(outcome.message)}\n`)
}

/**
 * Whether the session still resolves.
 *
 * `deps.isFresh`, when present, answers this ENTIRELY — no store lookup, no
 * `whoami` round trip (see the module doc's HIGH-review rationale). A throw
 * from it is treated the same as `false`, defensively: production's own
 * `isFresh` is a synchronous read of a local flag and cannot fail, but a
 * seam that answers "lost" on its own unexpected fault is safer than one that
 * propagates it into the console's fault path.
 *
 * Without it (a local console, or a caller that only set `resolve`), the
 * original behaviour holds: an unreadable store counts as lost as well — the
 * console cannot attribute the run, and fail-closed is the whole point of
 * re-checking. The sign-in screen it drops back to will report the store's
 * own detail if the fault persists.
 */
export async function isSessionFresh(token: string, deps: SessionDeps): Promise<boolean> {
  if (deps.isFresh !== undefined) {
    try {
      return await deps.isFresh(token)
    } catch {
      return false
    }
  }
  try {
    const resolved = await resolveAdmin(token, deps)
    return resolved.kind === 'ok'
  } catch {
    return false
  }
}
