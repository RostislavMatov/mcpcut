import { ADMIN_TOKEN_ENV_VAR } from '../admin/constants.js'
import { adminFromEnv, type TokenAdmin } from '../cli/admin-token.js'
import type { DispatchFn, DispatchOptions } from '../cli/dispatch-types.js'
import { captureBothIo, type CapturedBothIo } from '../setup/capture-io.js'
import { OUTPUT_CUT_NOTE, OUTPUT_MAX_CHARS } from './constants.js'
import type { Effect, Msg, RunRequest } from './model.js'
import { messageOf } from './runtime-terminal.js'
import { parseServicesJson } from './services-summary.js'
import { sessionEnvOf, withSessionToken } from './session-env.js'

/**
 * The effect executor (mcpcut phase 2, task 12): everything the console does
 * that is not a pure fold over its model — signing in, running a command,
 * asking the service manager what is up.
 *
 * This is the only module that holds the session token, and it holds it in
 * one deliberately mutable closure (`TokenCell`) rather than in the model:
 * the model is what a frame is rendered from, and a token that is not in it
 * cannot be drawn, scrolled into an output pane, or written to a log
 * (ADR-0004 — the token buys attribution, and it stays off the screen). It
 * leaves this file only through the `env` seams of `session-env.ts`, never in
 * argv, which the output pane prints back verbatim.
 *
 * Freshness is the second reason `run` goes through here rather than calling
 * `dispatch` directly. The store resolves a token to an admin, and an admin
 * rotated or removed from a shell must stop working in a console that is
 * already open — so every run re-resolves before it dispatches, exactly as the
 * web UI re-checks its session on every request. The old token's hash simply
 * no longer matches, and the console falls back to its sign-in screen.
 *
 * The third discipline is survival: no command may take the console down. A
 * `dispatch` that throws, or answers with something that is not an exit code,
 * becomes an ordinary failed run in the output pane — the exception to the
 * project's usual "unexpected errors propagate" rule, made on purpose because
 * an escaped rejection here would leave the terminal in raw mode.
 */

/** The one intentionally mutable cell of the runtime: the signed-in token. */
export interface TokenCell {
  get(): string | undefined
  set(token: string | undefined): void
}

/**
 * A fresh, empty cell. The value lives in the closure and is reachable only
 * through `get`, so nothing can enumerate, serialize or clone it by accident.
 */
export function createTokenCell(): TokenCell {
  let token: string | undefined
  return {
    get: () => token,
    set: (next: string | undefined) => {
      token = next
    },
  }
}

/** What executing an effect needs: the dispatcher, its seams, and the session. */
export interface EffectDeps {
  readonly dispatch: DispatchFn
  readonly dispatchOptions: DispatchOptions
  /** The environment commands inherit, before the session token is added to it. */
  readonly env: NodeJS.ProcessEnv
  /** Journal directory holding the admin store; defaults to the process-wide one. */
  readonly journalDir?: string
  readonly token: TokenCell
}

/** What a run reports when the command itself never got to answer. */
const FAILED_RUN_EXIT_CODE = 1

/** The command whose document fills the services part of the header. */
const SERVICES_STATUS_ARGV: readonly string[] = ['status', '--json']

/** A header that cannot say what the services are says so, rather than guessing. */
const NO_SERVICES: Msg = { kind: 'services', statuses: undefined }

const SESSION_LOST: Msg = { kind: 'session-lost' }

export async function executeEffect(effect: Effect, deps: EffectDeps): Promise<Msg | undefined> {
  switch (effect.kind) {
    case 'signin':
      return signIn(effect.token, deps)
    case 'run':
      return runCommand(effect.request, deps)
    case 'refresh-services':
      return refreshServices(deps)
    case 'quit':
      return undefined
  }
}

/**
 * Resolves a token through the same store lookup the admin CLI and the web UI
 * use. The token is handed over in an environment of its own rather than
 * through `deps.env`, so a stale `MCP_ADMIN_TOKEN` inherited by the console's
 * own process cannot answer for the operator who just typed one.
 */
async function resolveAdmin(token: string, deps: EffectDeps): Promise<TokenAdmin> {
  return adminFromEnv({
    env: { [ADMIN_TOKEN_ENV_VAR]: token },
    ...(deps.journalDir !== undefined ? { journalDir: deps.journalDir } : {}),
  })
}

/** Signs in: the token is kept only when the store named an admin behind it. */
async function signIn(token: string, deps: EffectDeps): Promise<Msg> {
  try {
    const result = await resolveAdmin(token, deps)
    if (result.kind === 'ok') deps.token.set(token)
    return { kind: 'signin-result', result }
  } catch (error: unknown) {
    // `adminFromEnv` rethrows a store fault it does not classify; on the
    // sign-in screen that is a notice to read, not a reason to lose the screen.
    return { kind: 'signin-result', result: { kind: 'unreadable', detail: messageOf(error) } }
  }
}

/**
 * Whether the session still resolves. An unreadable store counts as lost as
 * well: the console cannot attribute the run, and fail-closed is the whole
 * point of re-checking. The sign-in screen it drops back to will report the
 * store's own detail if the fault persists.
 */
async function isSessionFresh(token: string, deps: EffectDeps): Promise<boolean> {
  try {
    const resolved = await resolveAdmin(token, deps)
    return resolved.kind === 'ok'
  } catch {
    return false
  }
}

/** The caller's options with the session token on every seam that carries one. */
function optionsFor(token: string, deps: EffectDeps): DispatchOptions {
  return withSessionToken(deps.dispatchOptions, sessionEnvOf(deps.env, token))
}

async function runCommand(request: RunRequest, deps: EffectDeps): Promise<Msg> {
  const token = deps.token.get()
  if (token === undefined) return SESSION_LOST
  if (!(await isSessionFresh(token, deps))) {
    deps.token.set(undefined)
    return SESSION_LOST
  }
  const captured = captureBothIo(OUTPUT_MAX_CHARS)
  const outcome = await dispatchCaptured(request.argv, captured, token, deps)
  const stderrWithFailure =
    outcome.failure === undefined ? captured.err() : appended(captured.err(), outcome.failure)
  const stderr = captured.truncated()
    ? appended(stderrWithFailure, OUTPUT_CUT_NOTE)
    : stderrWithFailure
  return {
    kind: 'run-result',
    result: {
      argv: request.argv,
      display: request.display,
      exitCode: outcome.code,
      stdout: captured.out(),
      stderr,
    },
  }
}

/** An exit code, plus the message of the throw that stood in for one. */
interface DispatchOutcome {
  readonly code: number
  readonly failure?: string
}

/**
 * Runs one command with its output captured. Two things that would normally
 * be programming errors are answers here instead: a rejection, and a
 * resolution that is not an exit code (a `dispatch` seam under test, or a
 * command that fell off the end of its switch).
 */
async function dispatchCaptured(
  argv: readonly string[],
  captured: CapturedBothIo,
  token: string,
  deps: EffectDeps,
): Promise<DispatchOutcome> {
  try {
    const answer = await deps.dispatch([...argv], captured.io, optionsFor(token, deps))
    return { code: Number.isInteger(answer) ? answer : FAILED_RUN_EXIT_CODE }
  } catch (error: unknown) {
    return { code: FAILED_RUN_EXIT_CODE, failure: messageOf(error) }
  }
}

/**
 * Asks the service manager for its status document. Deliberately quieter than
 * `run`: this is a header refresh nobody asked for, so a failure — a refusal,
 * a throw, an unparsable document — leaves the header saying it does not know,
 * and never ends the session or steals the screen.
 */
async function refreshServices(deps: EffectDeps): Promise<Msg> {
  const token = deps.token.get()
  if (token === undefined) return NO_SERVICES
  if (!(await isSessionFresh(token, deps))) {
    deps.token.set(undefined)
    return SESSION_LOST
  }
  const captured = captureBothIo()
  try {
    // The exit code is not consulted: `status` exits 1 whenever a service is
    // not running, and still prints the document — which is exactly the
    // answer the header wants. An unparsable document reads as "unknown".
    await deps.dispatch([...SERVICES_STATUS_ARGV], captured.io, optionsFor(token, deps))
    return { kind: 'services', statuses: parseServicesJson(captured.out()) }
  } catch {
    return NO_SERVICES
  }
}


/** The failure on its own line, whatever the command had already written. */
function appended(stderr: string, failure: string): string {
  const separator = stderr === '' || stderr.endsWith('\n') ? '' : '\n'
  return `${stderr}${separator}${failure}\n`
}
