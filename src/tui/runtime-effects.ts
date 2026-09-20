import type { DispatchFn, DispatchOptions } from '../cli/dispatch-types.js'
import { captureBothIo } from '../setup/capture-io.js'
import type { ReopenCell, TokenCell, WizardOutcome, WizardOutcomeCell } from './cells.js'
import { OUTPUT_MAX_CHARS } from './constants.js'
import type {
  DeployStepId,
  Effect,
  FirstOwnerRemoteOutcome,
  Msg,
  RemoteProbeOutcome,
  RunRequest,
} from './model.js'
import type { RunResult } from './output.js'
import {
  FAILED_RUN_EXIT_CODE,
  failedRun,
  runResultOf,
  withFailure,
  type DispatchOutcome,
} from './run-result.js'
import { fileSink, memorySink, type RunSink, type SinkStreamFactory } from './run-sink.js'
import { isSessionFresh, signIn, type SessionDeps } from './runtime-signin.js'
import { messageOf } from './runtime-terminal.js'
import { parseServicesJson } from './services-summary.js'
import {
  sessionEnvOf,
  withoutAdminToken,
  withSeamEnv,
  withSecretInput,
  withSessionToken,
} from './session-env.js'

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
 * Phase 5 added the two effects that answer nobody's keystroke. `poll` is the
 * Approvals timer re-reading its own tab: the same session check as `run`, and
 * an answer the reducer folds without a running line. `reopen` is the SECOND
 * effect the runtime honours in `enqueue` rather than in the queue — the
 * wizard's `wizard-finish` was the first — because both only write a cell that
 * is read after the terminal has been given back, and a place in the queue
 * would mean waiting behind a command the operator has already left.
 *
 * The third discipline is survival: no command may take the console down. A
 * `dispatch` that throws, or answers with something that is not an exit code,
 * becomes an ordinary failed run in the output pane — the exception to the
 * project's usual "unexpected errors propagate" rule, made on purpose because
 * an escaped rejection here would leave the terminal in raw mode.
 */

// The cells themselves moved to `cells.ts` when the third one arrived
// (phase 5's `reopen`); they are re-exported here so every importer of this
// module — `tui-cmd.ts`, `tui-wizard.ts`, the tests — kept its import.
export {
  type Cell,
  createCell,
  createReopenCell,
  createTokenCell,
  createWizardOutcomeCell,
  type ReopenCell,
  type TokenCell,
  type WizardOutcome,
  type WizardOutcomeCell,
} from './cells.js'

/** What the first-run wizard needs of the runtime: somewhere to leave its answer. */
export interface WizardDeps {
  readonly outcome: WizardOutcomeCell
}

/**
 * What executing an effect needs: the dispatcher, its seams, and the session
 * (`SessionDeps` — the store, the token cell and the stderr the sign-in half
 * in `runtime-signin.ts` reports to).
 */
export interface EffectDeps extends SessionDeps {
  readonly dispatch: DispatchFn
  readonly dispatchOptions: DispatchOptions
  /** The environment commands inherit, before the session token is added to it. */
  readonly env: NodeJS.ProcessEnv
  /** Present only while the first-run wizard is on screen (phase 3). */
  readonly wizard?: WizardDeps
  /**
   * Where an action that leaves the console puts the argv to reopen with
   * (phase 5). Production ALWAYS wires it — `tui-cmd.ts` creates the cell
   * before the console opens — and the optional branch exists so the
   * runtime-effects unit harness can execute effects without one, where a
   * `reopen` is simply dropped.
   */
  readonly reopen?: ReopenCell
  /**
   * How an action's output file is opened; the default is the exclusive
   * create of `run-sink.ts`. The same seam `fileSink` takes, raised one level
   * so a test can hold the stream it opened and fail it under a command that
   * is parked on backpressure.
   */
  readonly openStream?: SinkStreamFactory
  /**
   * The first-owner screen's `POST setup` (ADR-0014): present only for a
   * console opened with `--remote`/`MCPCUT_REMOTE`, where an install has no
   * store this process can write to directly. Absent for a local console,
   * which mints its first owner with a sessionless `admin add` instead
   * (`first-owner-run`, `runSessionless`).
   */
  readonly remoteSetup?: (code: string, name: string) => Promise<FirstOwnerRemoteOutcome>
  /**
   * The welcome screen's "connect" probe (2026-09-19): a thin `GET state`
   * against the address the operator typed, so a bad host/port is answered
   * before the console commits to `reopen`-ing over it. Production wires this
   * to `createRemoteClient({ baseUrl: url }).state()` (`tui-cmd.ts`); absent
   * only for a caller that never wired it, in which case the probe is refused
   * like any other unreachable address rather than the runtime crashing.
   */
  readonly probeRemote?: (url: string) => Promise<RemoteProbeOutcome>
  /**
   * "Remember the last address" (2026-09-20): called with the normalised url
   * the moment a `connect-probe` succeeds, BEFORE the `connect-probe-result`
   * message reaches the reducer — so the write has either finished or failed
   * (a stderr warning) by the time the reducer's `reopen` hands the terminal
   * away. Absent for `--remote`/`MCPCUT_REMOTE` (the scripted path never
   * writes this file) and for the local console (there is nothing to
   * remember). A failure never blocks connecting: the operator is simply
   * asked again next time (`src/tui/remote/saved.ts`).
   */
  readonly rememberRemote?: (url: string) => Promise<void>
  /**
   * "A way to disconnect" (2026-09-20): forgets the saved address, if any.
   * Present only on a console opened over `--remote`/`MCPCUT_REMOTE`/a saved
   * address — there is nothing to forget on a local console, and Home's
   * `disconnect` action is withdrawn there (`meetsRequirement`). A failure is
   * one stderr line and never a reason to stay connected.
   */
  readonly forgetRemote?: () => Promise<void>
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
    case 'first-owner-run':
      return { kind: 'first-owner-result', result: await runSessionless(effect.request, deps) }
    case 'first-owner-setup':
      return { kind: 'first-owner-setup-result', result: await runRemoteSetup(effect.code, effect.name, deps) }
    case 'poll':
      return pollCommand(effect.request, deps)
    case 'connect-probe':
      return connectProbe(effect.url, deps)
    case 'disconnect':
      // Same shape as `reopen` below: the runtime ends the console in
      // `enqueue` before this case is ever reached in production, and it is
      // here only so a direct call (a test, or a future caller) still forgets
      // the address before handing the terminal away.
      await forgetRemoteQuietly(deps)
      deps.reopen?.set([...effect.argv])
      return undefined
    case 'wizard-finish':
      // The runtime answers this one in `enqueue`; the case is here so the
      // switch stays exhaustive and a direct call still does the right thing.
      finishWizard(deps)
      return undefined
    case 'reopen':
      // Same shape as `wizard-finish`: the runtime ends the console in
      // `enqueue` and runs this argv once the terminal is its own again. The
      // copy is the one `enqueue` makes too: the argv outlives the effect, and
      // whoever reads the cell spawns from it.
      deps.reopen?.set([...effect.argv])
      return undefined
    case 'quit':
      return undefined
  }
}

// Resolving a token, signing in and the freshness check live in
// `runtime-signin.ts` since phase 6, when the sign-in grew the removal of the
// first-run file (F6) and this file had no room for it.

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
 * The seams still get an environment — the console's own MINUS the admin
 * token, through `withoutAdminToken` — so an `MCPCUT_CONFIG` the operator
 * exported reaches both the `setup` that writes that file and the `start` that
 * reads it, while an `MCP_ADMIN_TOKEN` left in the shell reaches neither. The
 * console strips it from every dispatch it makes without a session, the
 * pre-sign-in `status` included: an install that has no admins yet has nobody
 * for such a token to name, and passing it on would be the console picking an
 * identity nobody typed.
 */
async function runWizardCommand(
  step: DeployStepId,
  request: RunRequest,
  deps: EffectDeps,
): Promise<Msg> {
  return { kind: 'wizard-run-result', step, result: await runSessionless(request, deps) }
}

/**
 * A command dispatched with no session and no admin token in its environment:
 * the wizard's ladder, and the first-owner screen's `admin add` — which the
 * CLI accepts without a token only while the store is empty, so a console
 * that lost the race to a shell is refused by the command itself.
 */
async function runSessionless(request: RunRequest, deps: EffectDeps): Promise<RunResult> {
  const sink = memorySink(OUTPUT_MAX_CHARS)
  const outcome = await dispatchCaptured(
    request.argv,
    sink,
    withSeamEnv(deps.dispatchOptions, withoutAdminToken(deps.env)),
    deps,
  )
  return runResultOf(request, sink, outcome)
}

/**
 * The first-owner screen's remote `POST setup` (ADR-0014). `deps.remoteSetup`
 * is absent on a local console — a wiring fault, not an operator one, so it
 * is answered rather than thrown: the effect queue's own discipline is that
 * no command may take the console down, and a first run is exactly where a
 * crash would be least explicable. A throw from the call itself (a network
 * fault the client did not already turn into an outcome) is answered the
 * same way, on the form, rather than escaping to `runConsole`'s fault path.
 */
async function runRemoteSetup(
  code: string,
  name: string,
  deps: EffectDeps,
): Promise<FirstOwnerRemoteOutcome> {
  if (deps.remoteSetup === undefined) {
    return { kind: 'refused', message: 'this console has no remote install to set up' }
  }
  try {
    return await deps.remoteSetup(code, name)
  } catch (error: unknown) {
    return { kind: 'refused', message: messageOf(error) }
  }
}

/** What the welcome screen's probe answers with when nothing wired `probeRemote` at all. */
const NO_PROBE_SEAM_MESSAGE = 'this console has no way to reach a remote install'

/** The stderr line's prefix when the saved remote address could not be written or forgotten. */
const REMEMBER_REMOTE_WARNING_PREFIX = 'warning: could not remember this address for next time: '
const FORGET_REMOTE_WARNING_PREFIX = 'warning: could not forget the saved remote address: '

/**
 * The welcome screen's "connect" probe (2026-09-19). Deliberately never
 * throws past this point: an unreachable host, a DNS failure or a TLS
 * handshake gone wrong are ordinary reasons to try again with different
 * answers, not a reason to take the console down (the same discipline
 * `dispatchCaptured` holds a real command to).
 *
 * A SUCCESSFUL probe remembers the address (2026-09-20, "remember the last
 * address") before the message is returned: `update-welcome.ts`'s `reopen`
 * follows immediately once the reducer folds this in, so the write must have
 * already happened — or already failed onto stderr — by then.
 */
async function connectProbe(url: string, deps: EffectDeps): Promise<Msg> {
  if (deps.probeRemote === undefined) {
    return { kind: 'connect-probe-result', url, result: { ok: false, message: NO_PROBE_SEAM_MESSAGE } }
  }
  let result: RemoteProbeOutcome
  try {
    result = await deps.probeRemote(url)
  } catch (error: unknown) {
    return { kind: 'connect-probe-result', url, result: { ok: false, message: messageOf(error) } }
  }
  if (result.ok) await rememberRemoteQuietly(url, deps)
  return { kind: 'connect-probe-result', url, result }
}

/** Saves the address, or writes ONE stderr line — never a reason to refuse a connection that works. */
async function rememberRemoteQuietly(url: string, deps: EffectDeps): Promise<void> {
  if (deps.rememberRemote === undefined) return
  try {
    await deps.rememberRemote(url)
  } catch (error: unknown) {
    deps.stderr?.write(`${REMEMBER_REMOTE_WARNING_PREFIX}${messageOf(error)}\n`)
  }
}

/**
 * Forgets the saved address, or writes ONE stderr line — never a reason to
 * stay connected. Exported so `runtime.ts`'s `enqueue` can fire it before
 * ending the console on a `disconnect` effect, exactly as it fires
 * `finishWizard` before a `wizard-finish`.
 */
export async function forgetRemoteQuietly(deps: EffectDeps): Promise<void> {
  if (deps.forgetRemote === undefined) return
  try {
    await deps.forgetRemote()
  } catch (error: unknown) {
    deps.stderr?.write(`${FORGET_REMOTE_WARNING_PREFIX}${messageOf(error)}\n`)
  }
}

/**
 * A quiet re-read of a section (the Approvals timer): the same session check
 * as `run`, a memory sink, and an answer the reducer folds without touching
 * `busy`. Nobody asked for it, so it never takes the screen — but a session
 * that has gone is still a session that has gone.
 */
async function pollCommand(request: RunRequest, deps: EffectDeps): Promise<Msg> {
  const token = deps.token.get()
  if (token === undefined) return SESSION_LOST
  if (!(await isSessionFresh(token, deps))) {
    deps.token.set(undefined)
    return SESSION_LOST
  }
  const sink = memorySink(OUTPUT_MAX_CHARS)
  const outcome = await dispatchCaptured(request.argv, sink, optionsFor(token, deps), deps)
  return { kind: 'poll-result', result: runResultOf(request, sink, outcome) }
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
 *
 * It is asked WITHOUT a session too (phase 5, plan P3). `status` needs no
 * token — it reads pid files and probes ports, exactly as `mcpcut status`
 * would from the shell — and the sign-in screen is the one place the answer
 * matters most: an operator staring at a token prompt while `ui` and `serve`
 * are down should be told so, not left to guess. The seams then carry the
 * console's OWN environment MINUS the admin token (`withoutAdminToken`), so an
 * `MCPCUT_CONFIG` the operator exported still points `status` at the install
 * they mean, while an `MCP_ADMIN_TOKEN` left in the shell does not become an
 * identity the console picked for a command nobody signed in for.
 */
async function refreshServices(deps: EffectDeps): Promise<Msg> {
  const token = deps.token.get()
  if (token !== undefined && !(await isSessionFresh(token, deps))) {
    deps.token.set(undefined)
    return SESSION_LOST
  }
  const options =
    token === undefined
      ? withSeamEnv(deps.dispatchOptions, withoutAdminToken(deps.env))
      : optionsFor(token, deps)
  const captured = captureBothIo()
  try {
    // The exit code is not consulted: `status` exits 1 whenever a service is
    // not running, and still prints the document — which is exactly the
    // answer the header wants. An unparsable document reads as "unknown".
    await deps.dispatch([...SERVICES_STATUS_ARGV], captured.io, options)
    return { kind: 'services', statuses: parseServicesJson(captured.out()) }
  } catch {
    return NO_SERVICES
  }
}
