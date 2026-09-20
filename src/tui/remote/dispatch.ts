import { ADMIN_TOKEN_ENV_VAR } from '../../admin/constants.js'
import type { DispatchFn, DispatchOptions } from '../../cli/dispatch-types.js'
import { FAILED_RUN_EXIT_CODE } from '../run-result.js'
import type { RemoteClient } from './client.js'

/**
 * The console's `DispatchFn`, backed by `POST run` instead of `cli.ts`'s
 * router (ADR-0014, plan wave 2 task 2).
 *
 * The seams it reads are the ones the console already fills for the LOCAL
 * dispatcher (`session-env.ts`): the admin token on `options.admin.env`,
 * because `withSeamEnv` sets the same environment object on every one of
 * `SESSION_ENV_SEAMS` — `admin` among them — so this is one place to look
 * whatever top-level command produced the argv. `options.vault
 * .readSecretInput` is read the same way `runtime-effects.ts` calls it: only
 * when the action set it (`withSecretInput`, `vault set`), never unconditionally
 * — most commands carry no secret at all.
 *
 * No token on the options means no admin has signed in over this dispatch —
 * the sign-in screen's own `status --json` probe, before anybody typed a
 * token. Locally that is an ordinary sessionless run; remotely there is
 * nothing to authenticate the request with, and the answer is a quiet
 * failure with NO request at all: contacting the server would either be
 * refused (an empty `Authorization` header names nobody) or, worse, would
 * dial out with no credential on a screen the operator has not signed in on
 * yet.
 */

/**
 * Seams `createRemoteDispatch` runs on, beyond the client itself (ADR-0014
 * HIGH review — a network blip must not sign the operator out).
 */
export interface RemoteDispatchDeps {
  /**
   * Called when — and ONLY when — `client.run`'s structured refusal for THIS
   * run was `unauthorized`: the server itself says the bearer token no longer
   * names a live admin (revoked, rotated, or never existed to begin with). A
   * network failure, a different refusal (`forbidden`, `rate-limited`, …) or
   * an ordinary non-zero exit must never reach this — those are failed runs,
   * not lost sessions, and `client.run`'s own `onRefusal` callback already
   * keeps the distinction (`src/tui/remote/client.ts`).
   *
   * `src/cli/tui-remote.ts` wires this to a small revoked-flag cell that
   * `SessionDeps.isFresh` reads: the NEXT effect (a run, a poll, the header
   * refresh) is what actually drops the session, not this call itself — a
   * run answered `unauthorized` still finishes as one ordinary failed run in
   * the output pane, showing the server's own message.
   */
  readonly onUnauthorized?: () => void
}

export function createRemoteDispatch(client: RemoteClient, deps: RemoteDispatchDeps = {}): DispatchFn {
  return async (argv, io, opts: DispatchOptions = {}) => {
    const token = opts.admin?.env?.[ADMIN_TOKEN_ENV_VAR]
    if (token === undefined || token === '') return FAILED_RUN_EXIT_CODE

    const stdin = await secretOf(opts)
    return client.run(
      { argv: [...argv], ...(stdin === undefined ? {} : { stdin }) },
      token,
      io,
      (kind) => {
        if (kind === 'unauthorized') deps.onUnauthorized?.()
      },
    )
  }
}

/** The vault secret an action carries, when it carries one — never called otherwise. */
async function secretOf(opts: DispatchOptions): Promise<string | undefined> {
  const reader = opts.vault?.readSecretInput
  return reader === undefined ? undefined : reader()
}
