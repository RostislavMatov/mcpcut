import { ADMIN_TOKEN_ENV_VAR } from '../admin/constants.js'
import { adminFromEnv, type TokenAdmin } from '../cli/admin-token.js'
import type { DispatchFn, DispatchOptions } from '../cli/dispatch-types.js'
import { captureBothIo } from '../setup/capture-io.js'
import { OUTPUT_MAX_CHARS } from './constants.js'
import type { DeployStepId, Effect, Msg, RunRequest } from './model.js'
import {
  FAILED_RUN_EXIT_CODE,
  failedRun,
  runResultOf,
  withFailure,
  type DispatchOutcome,
} from './run-result.js'
import { fileSink, memorySink, type RunSink, type SinkStreamFactory } from './run-sink.js'
import { messageOf } from './runtime-terminal.js'
import { parseServicesJson } from './services-summary.js'
import { sessionEnvOf, withSeamEnv, withSecretInput, withSessionToken } from './session-env.js'

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
 * no longer matches, and the console falls back to its sign-in screen. The
 * first-run wizard (phase 3) is the one documented exception: `wizard-run`
 * dispatches with no session at all, because the install it is building has
 * no admin to resolve until `setup` has minted one — see `runWizardCommand`.
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

/**
 * What the wizard asked the runtime for once its last screen is done. One
 * value today — the operator wants the sign-in screen — and it is a named
 * type rather than a boolean so a second answer (phase 5's "just quit") is an
 * addition here rather than a re-reading of `true`.
 */
export type WizardOutcome = 'sign-in'

/** The wizard's own mutable cell: the single channel out of an effect. */
export interface WizardOutcomeCell {
  get(): WizardOutcome | undefined
  set(outcome: WizardOutcome | undefined): void
}

/** A fresh, empty cell; the value lives in the closure, as `createTokenCell`'s does. */
export function createWizardOutcomeCell(): WizardOutcomeCell {
  let outcome: WizardOutcome | undefined
  return {
    get: () => outcome,
    set: (next: WizardOutcome | undefined) => {
      outcome = next
    },
  }
}

/** What the first-run wizard needs of the runtime: somewhere to leave its answer. */
export interface WizardDeps {
  readonly outcome: WizardOutcomeCell
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
  /** Present only while the first-run wizard is on screen (phase 3). */
  readonly wizard?: WizardDeps
  /**
   * How an action's output file is opened; the default is the exclusive
   * create of `run-sink.ts`. The same seam `fileSink` takes, raised one level
   * so a test can hold the stream it opened and fail it under a command that
   * is parked on backpressure.
   */
  readonly openStream?: SinkStreamFactory
}

/** The command whose document fills the services part of the header. */
const SERVICES_STATUS_ARGV: readonly string[] = ['status', '--json']

/** A header that cannot say what the services are says so, rather than guessing. */
const NO_SERVICES: Msg = { kind: 'services', statuses: undefined }

const SESSION_LOST: Msg = { kind: 'session-lost' }

/** The one outcome the wizard can ask for today. */
const WIZARD_SIGN_IN: WizardOutcome = 'sign-in'

/**
 * Leaves the wizard's answer in its cell.
 *
 * Synchronous, and exported for that reason: the runtime writes the cell in
 * the same turn as the step that asked for it, because the quit beside it
 * settles the console and a bounded drain is no place for the one answer the
 * wizard exists to hand back. The runtime reads the cell after `runConsole`
 * has given the terminal back, and only then reopens the console on its
 * sign-in screen.
 */
export function finishWizard(deps: EffectDeps): void {
  deps.wizard?.outcome.set(WIZARD_SIGN_IN)
}

export async function executeEffect(effect: Effect, deps: EffectDeps): Promise<Msg | undefined> {
  switch (effect.kind) {
    case 'signin':
      return signIn(effect.token, deps)
    case 'run':
      return runCommand(effect.request, deps, effect.stdin)
    case 'refresh-services':
      return refreshServices(deps)
    case 'wizard-run':
      return runWizardCommand(effect.step, effect.request, deps)
    case 'wizard-finish':
      // The runtime answers this one in `enqueue`; the case is here so the
      // switch stays exhaustive and a direct call still does the right thing.
      finishWizard(deps)
      return undefined
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

/**
 * One command of the catalogue, run on behalf of the signed-in operator.
 *
 * `stdin` is the vault secret and reaches the dispatcher through the vault's
 * own seam — it is a parameter rather than a field of `request` because the
 * request is part of the model and a secret must never be in one (ADR-0004).
 * `request.stdoutPath` is the other half of the same discipline in reverse:
 * output too large for a pane goes to a file, and the pane gets a receipt.
 *
 * A sink that cannot be opened ends the run BEFORE `dispatch`: there is
 * nowhere to put what the command would print, and running it anyway would
 * mean an export that quietly went nowhere.
 */
async function runCommand(request: RunRequest, deps: EffectDeps, stdin?: string): Promise<Msg> {
  const token = deps.token.get()
  if (token === undefined) return SESSION_LOST
  if (!(await isSessionFresh(token, deps))) {
    deps.token.set(undefined)
    return SESSION_LOST
  }
  const opened = await openSink(request, deps.openStream)
  if ('failure' in opened) {
    return { kind: 'run-result', result: failedRun(request, opened.failure) }
  }
  const options = runOptions(token, deps, stdin)
  const outcome = await dispatchCaptured(request.argv, opened.sink, options, deps)
  // Closed only now: the command may still have been writing, and `finished`
  // waits for the file to be flushed and closed before `out()` is read back.
  const closeFailure = await finishFailure(opened.sink)
  return {
    kind: 'run-result',
    result: runResultOf(request, opened.sink, withFailure(outcome, closeFailure)),
  }
}

/** The session's options, plus the vault's secret reader when the action carries one. */
function runOptions(token: string, deps: EffectDeps, stdin: string | undefined): DispatchOptions {
  const options = optionsFor(token, deps)
  return stdin === undefined ? options : withSecretInput(options, stdin)
}

/** A sink to run into, or the reason there is none. */
type OpenedSink = { readonly sink: RunSink } | { readonly failure: string }

/** Opens where this run's output goes: a file when the action named a path, memory otherwise. */
async function openSink(
  request: RunRequest,
  openStream: SinkStreamFactory | undefined,
): Promise<OpenedSink> {
  if (request.stdoutPath === undefined) return { sink: memorySink(OUTPUT_MAX_CHARS) }
  try {
    const sink =
      openStream === undefined
        ? await fileSink(request.stdoutPath, OUTPUT_MAX_CHARS)
        : await fileSink(request.stdoutPath, OUTPUT_MAX_CHARS, openStream)
    return { sink }
  } catch (error: unknown) {
    return { failure: messageOf(error) }
  }
}

/** Closes the sink, answering with the write failure it kept rather than throwing it. */
async function finishFailure(sink: RunSink): Promise<string | undefined> {
  try {
    await sink.finish()
    return undefined
  } catch (error: unknown) {
    return messageOf(error)
  }
}

/**
 * One rung of the first-run wizard's deploy ladder (`setup --yes`,
 * `start ui`, `start serve`).
 *
 * Deliberately NOT `runCommand`: it neither checks session freshness nor
 * reads `TokenCell`, because at this point in an install THERE IS NO ADMIN —
 * `setup` is the command that mints the first one. Demanding a resolved
 * session here would refuse the very run that creates the session, and there
 * is nothing to attribute yet: the wizard's own commands are journaled by
 * `setup` itself, under the admin it creates.
 *
 * The seams still get an environment — the console's own, through
 * `withSeamEnv` — so an `MCPCUT_CONFIG` the operator exported reaches both
 * the `setup` that writes that file and the `start` that reads it. It carries
 * no `MCP_ADMIN_TOKEN` of ours; a stale one inherited from the shell is the
 * operator's own environment and is passed through unchanged, exactly as it
 * would be had they typed `mcpcut setup --yes` themselves.
 */
async function runWizardCommand(
  step: DeployStepId,
  request: RunRequest,
  deps: EffectDeps,
): Promise<Msg> {
  const sink = memorySink(OUTPUT_MAX_CHARS)
  const outcome = await dispatchCaptured(
    request.argv,
    sink,
    withSeamEnv(deps.dispatchOptions, deps.env),
    deps,
  )
  return { kind: 'wizard-run-result', step, result: runResultOf(request, sink, outcome) }
}

/**
 * Runs one command with its output captured. Two things that would normally
 * be programming errors are answers here instead: a rejection, and a
 * resolution that is not an exit code (a `dispatch` seam under test, or a
 * command that fell off the end of its switch).
 *
 * The options are the caller's, not built here: a run of the signed-in
 * console carries the session token on its seams, a rung of the wizard
 * carries the console's plain environment.
 */
async function dispatchCaptured(
  argv: readonly string[],
  sink: RunSink,
  options: DispatchOptions,
  deps: EffectDeps,
): Promise<DispatchOutcome> {
  try {
    const answer = await deps.dispatch([...argv], sink.io, options)
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
