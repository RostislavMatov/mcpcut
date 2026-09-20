import type { ConsoleRunner } from '../console-api/runner.js'
import { sessionEnvOf, withSecretInput, withSessionToken } from '../tui/session-env.js'
import type { DispatchFn, DispatchOptions } from './dispatch-types.js'

/**
 * Builds the `ConsoleRunner` `src/ui/console-run.ts` calls for
 * `POST /api/console/run` (ADR-0014, wave 1) out of the SAME `dispatch`
 * value the local console (`tui-cmd.ts`) already runs on — never an import of
 * `src/cli.ts` (`tests/architecture/imports.test.ts` forbids that from
 * anywhere under `src/`), which is why `dispatch` arrives here as a plain
 * function value, handed down from `cli.ts`'s own `ui` command line.
 *
 * The token/secret handling mirrors the local console's discipline
 * (`src/tui/session-env.ts`) exactly, because the threat the two guard
 * against is the same one stated there: neither may ever reach `argv` (an
 * output pane's "equivalent command" line) or the model a frame is drawn
 * from — over the network the equivalent surface is the request body and the
 * NDJSON frames this run writes back, and `console-run.ts`'s own catch never
 * interpolates either. So:
 *
 *  - The bearer token the HTTP layer already verified becomes
 *    `MCP_ADMIN_TOKEN` in the dispatched command's OWN environment
 *    (`sessionEnvOf` + `withSessionToken`'s seam list), never a CLI argument.
 *  - A request's `stdin` (the one secret a form may carry, `vault set`'s
 *    value) is wired the same way the console wires a typed secret:
 *    `withSecretInput` hands the dispatched command a closure that resolves
 *    to it once, never the process's own `process.stdin` — there is none to
 *    read here, this is a daemon, and a command that fell back to it would
 *    hang forever waiting for a pipe nobody is writing to.
 *  - A request with NO `stdin` gets a reader that REJECTS with a clear
 *    message, rather than silently having no seam at all: without this a
 *    library-level bug that reached for `readSecretInput` regardless of
 *    whether the request carried one would surface as a hang, not a refusal.
 */

export interface ConsoleRunnerDeps {
  /** The dispatcher this runner calls into — the same value `cli.ts` hands `runTui`. */
  readonly dispatch: DispatchFn
  /**
   * Base dispatch options every run starts from (test seams; production
   * passes none, so each run resolves its stores exactly as a real shell
   * invocation of this same binary would — the ADR-0012 §19 "console ≡ shell
   * under the service's uid" model, now over the network too).
   */
  readonly baseOptions?: DispatchOptions
  /** Environment the daemon's own runs start from, before the request's token joins it. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
}

/** What a request with no `stdin` gets instead of a working secret reader. */
function refusingSecretInput(): Promise<string> {
  return Promise.reject(
    new Error('remote console: this run carries no secret input for a command that asked for one'),
  )
}

export function createConsoleRunner(deps: ConsoleRunnerDeps): ConsoleRunner {
  const baseEnv = deps.env ?? process.env
  const baseOptions = deps.baseOptions ?? {}

  return async function runConsoleCommand(request, io): Promise<number> {
    const sessionEnv = sessionEnvOf(baseEnv, request.token)
    const withToken = withSessionToken(baseOptions, sessionEnv)
    const options =
      request.stdin !== undefined
        ? withSecretInput(withToken, request.stdin)
        : { ...withToken, vault: { ...withToken.vault, readSecretInput: refusingSecretInput } }
    return deps.dispatch(request.argv, io, options)
  }
}
