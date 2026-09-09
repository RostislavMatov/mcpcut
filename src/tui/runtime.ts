import type { CliWritable } from '../cli/dispatch-types.js'
import { frameOf, type Style } from './ansi.js'
import {
  EXIT_INTERRUPTED,
  EXIT_OK,
  QUIT_DRAIN_TIMEOUT_MS,
  WINDOWS_UNSUPPORTED_REASON,
} from './constants.js'
import { keyEventOf, type ReadlineKey } from './keys.js'
import { initialModel, type Effect, type Model, type Msg, type TerminalSize } from './model.js'
import { render } from './render.js'
import { executeEffect, finishWizard, type EffectDeps } from './runtime-effects.js'
import { createSubscriptionTimer } from './runtime-timer.js'
import {
  attempt,
  enterTerminal,
  messageOf,
  restoreTerminal,
  sizeOf,
  type TuiOutput,
  type TuiTerminal,
} from './runtime-terminal.js'
import { subscriptionOf } from './subscriptions.js'
import { update } from './update.js'

/**
 * The console's runtime (mcpcut phase 2, task 13): the ONE effectful module
 * of the console.
 *
 * Everything above it is pure — `update` folds a message into a model,
 * `render` turns a model into lines — and everything below it is the CLI the
 * console is a client of. This file is the part that runs, and it owns three
 * promises to the operator who typed `mcpcut`.
 *
 * The first is that the terminal comes back. Raw mode and the alternate
 * screen are process-wide state borrowed from the shell, and a console that
 * exits without giving them back leaves a terminal with no echo and no
 * scrollback. So `restoreTerminal` runs in a `finally` that no exit path can
 * skip: a quit key, an interrupt, a signal, an uncaught exception, a `render`
 * that threw, a pty that died mid-frame.
 *
 * The second is that nothing it installs outlives it. The signal listeners
 * and the `uncaughtException`/`unhandledRejection` listeners go onto the
 * process for exactly as long as the console is on screen, and come off in
 * that same `finally` — the pattern `ui-cmd.ts` established for `serve`.
 *
 * The third is that `runConsole` RESOLVES, always, with an exit code. Its
 * caller is a CLI command with nothing left to do but end the process, and an
 * escaped rejection here would be an unhandled rejection of the very kind
 * this module installs a listener for.
 *
 * A note on what does NOT belong here: a command that fails is not the
 * console's failure. `executeEffect` turns a throwing `dispatch` into an
 * ordinary failed run in the output pane; a throw that reaches THIS module
 * came from the runtime or the pure core, and ends the console with 1.
 */

/** The platform whose terminal has neither POSIX raw mode nor these signals. */
const WINDOWS_PLATFORM: NodeJS.Platform = 'win32'

/** Events the runtime listens for, named once so install and remove agree. */
const KEYPRESS_EVENT = 'keypress'
const RESIZE_EVENT = 'resize'
const UNCAUGHT_EXCEPTION_EVENT = 'uncaughtException'
const UNHANDLED_REJECTION_EVENT = 'unhandledRejection'
const OUTPUT_ERROR_EVENT = 'error'

export type { TuiInput, TuiOutput, TuiTerminal } from './runtime-terminal.js'

export interface ConsoleDeps {
  readonly terminal: TuiTerminal
  readonly style: Style
  /** Where a fault the console cannot draw goes, once the screen is gone. */
  readonly stderr: CliWritable
  readonly effects: EffectDeps
  /** `process` in production, a bare emitter in tests. */
  readonly processEvents: NodeJS.EventEmitter
  readonly signals: readonly NodeJS.Signals[]
  readonly escapeCodeTimeoutMs: number
  /** How long a quit waits for the command in flight; defaults to `QUIT_DRAIN_TIMEOUT_MS`. */
  readonly quitDrainTimeoutMs?: number
  /**
   * The screen the console opens on, built from the size of the terminal it
   * was handed; the sign-in screen when absent. The seam exists for the
   * first-run wizard (phase 3), which is a whole screen the caller has
   * already prefilled from a config that may not exist yet — knowledge the
   * runtime has no business acquiring. Called exactly ONCE, at startup: a
   * later resize takes its size from the event, not from here.
   */
  readonly initial?: (size: TerminalSize) => Model
  readonly platform: NodeJS.Platform
}

/**
 * Runs the console until it is asked to leave, and answers with the exit code
 * the caller should end the process with.
 */
export async function runConsole(deps: ConsoleDeps): Promise<number> {
  if (deps.platform === WINDOWS_PLATFORM) {
    // Before the terminal is touched at all: there is nothing to restore yet,
    // and the refusal is a line of stderr like any other command's.
    writeSafely(deps.stderr, `${WINDOWS_UNSUPPORTED_REASON}\n`)
    return EXIT_INTERRUPTED
  }

  const loop = createLoop(deps)
  let removeListeners: () => void = () => undefined
  try {
    enterTerminal(deps.terminal, deps.escapeCodeTimeoutMs)
    removeListeners = installListeners(deps, loop)
    loop.open()
    await loop.finished
    await loop.drain()
  } catch (error: unknown) {
    // Nothing above rejects by design, so this is the last line of the
    // promise the caller holds: it resolves with 1 rather than throwing.
    loop.fail(error)
  } finally {
    removeListeners()
    restoreTerminal(deps.terminal)
    // The session token has no business outliving the screen it served.
    attempt(() => deps.effects.token.set(undefined))
    // Only now, with the shell's own screen back, can a fault be read.
    loop.reportFault()
  }

  return loop.exitCode()
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * The mutable half of a running console, behind the verbs it needs.
 *
 * Exported with `createLoop` as the seam for the messages a terminal cannot
 * produce: a `wizard-run-result` arrives from an effect, never from a key, so
 * the queue's own promises — what a settled console still honours, and what
 * it drops — are asserted by driving `step` directly.
 */
export interface ConsoleLoop {
  /** Resolves once the console has been asked to leave; never rejects. */
  readonly finished: Promise<void>
  draw(): void
  /** Draws the first frame and tells the model it is on screen (`opened`). */
  open(): void
  step(msg: Msg): void
  /** Ends the console with `code`; the first call wins, the rest are no-ops. */
  finish(code: number): void
  /** Records a fault of the runtime or the core and ends the console with 1. */
  fail(error: unknown): void
  /** Writes the recorded fault, if any, to stderr — once the screen is gone. */
  reportFault(): void
  /** Waits for the effect in flight, but no longer than the drain timeout. */
  drain(): Promise<void>
  exitCode(): number
}

export function createLoop(deps: ConsoleDeps): ConsoleLoop {
  let model: Model = (deps.initial ?? initialModel)(sizeOf(deps.terminal.output))
  let settled = false
  let exitCode = EXIT_OK
  /** The first fault, kept until the alternate screen is gone: a report drawn onto it would vanish with it. */
  let fault: string | undefined
  /** Effects run strictly one after another; a step may add to the tail. */
  let chain: Promise<void> = Promise.resolve()
  let settle: () => void = () => undefined
  const finished = new Promise<void>((resolve) => {
    settle = resolve
  })

  const finish = (code: number): void => {
    if (settled) return
    settled = true
    // Before `settle()`: a `step` on a settled console is a no-op anyway, but
    // a live `setTimeout` outliving the screen is a leak whichever way it
    // would have been ignored (and the timer is unref'd, so nothing else
    // would ever surface it).
    timer.clear()
    exitCode = code
    settle()
  }

  /**
   * The console's single timer, reconciled after every step against what the
   * model subscribes to (`subscriptionOf`). A tick is an ordinary message: the
   * reducer asks the same question again and drops what is no longer due.
   */
  const timer = createSubscriptionTimer(() => step({ kind: 'tick' }))

  const draw = (): void => {
    // `render` is outside the `try` on purpose: a throw from the pure core is
    // a bug to report, while a write that fails is a terminal that is gone.
    const frame = frameOf(render(model, deps.style))
    try {
      deps.terminal.output.write(frame)
    } catch {
      finish(EXIT_INTERRUPTED)
    }
  }

  const fail = (error: unknown): void => {
    // A listener for `uncaughtException` makes the exception "handled" as far
    // as Node is concerned, so saying what happened is now our job — and the
    // stack is the only diagnostic a runtime bug leaves behind.
    fault ??= describeFault(error)
    // The argv an action left behind is withdrawn: `finish` is first-call-wins,
    // so a fault AFTER a reopen would leave the exit code at 0 with the stack
    // only on stderr, and the caller would hand the terminal to a child on
    // behalf of a console that had crashed.
    attempt(() => deps.effects.reopen?.set(undefined))
    finish(EXIT_INTERRUPTED)
  }

  const reportFault = (): void => {
    if (fault !== undefined) writeSafely(deps.stderr, `${fault}\n`)
  }

  const step = (msg: Msg): void => {
    if (settled) return
    try {
      const next = update(model, msg)
      model = next.model
      draw()
      for (const effect of next.effects) enqueue(effect)
      // AFTER the effects: a `poll` among them puts `polling` on the model,
      // and the subscription is gone while a poll is out — which is what makes
      // the interval count from the answer rather than from the tick.
      timer.reconcile(subscriptionOf(model))
    } catch (error: unknown) {
      fail(error)
    }
  }

  const perform = async (effect: Effect): Promise<void> => {
    // A settled console has nothing left to fold a result into, so its queue
    // is abandoned.
    if (settled) return
    const msg = await executeEffect(effect, deps.effects)
    if (msg !== undefined) step(msg)
  }

  /**
   * One effect at a time, in the order the reducer asked for them. The
   * reducer already refuses a second run while one is in flight; the queue is
   * what keeps a header refresh from overtaking the run it was asked for.
   *
   * A quit is not a step in the queue: it is the operator no longer wanting
   * what the queue is doing, so it takes effect at once and `drain` bounds
   * how long the command in flight is waited for.
   *
   * `wizard-finish` is honoured at once for the same reason. It runs no
   * command — it writes one cell — and the wizard's final screen asks for it
   * in the SAME step as the quit, so a place in the queue would mean the
   * answer waits behind whatever is in flight and is lost the moment that
   * outlives the drain.
   *
   * `reopen` is the third, and it ends the console itself: the action has
   * already been confirmed, the terminal is about to belong to a child
   * process, and there is nothing to be gained by waiting for a command the
   * operator has walked away from — the same argument the quit makes.
   */
  const enqueue = (effect: Effect): void => {
    if (effect.kind === 'quit') {
      finish(effect.exitCode)
      return
    }
    if (effect.kind === 'wizard-finish') {
      finishWizard(deps.effects)
      return
    }
    if (effect.kind === 'reopen') {
      // Copied: the argv outlives the effect, and the runtime hands it to a
      // caller that will spawn from it.
      deps.effects.reopen?.set([...effect.argv])
      finish(EXIT_OK)
      return
    }
    chain = chain.then(() => perform(effect)).catch(fail)
  }

  /**
   * The first frame, and then the message that says it is up. `opened` is what
   * the sign-in screen answers with a token-free `status`, so that an operator
   * who cannot sign in is at least told the services are down (plan P3).
   */
  const open = (): void => {
    draw()
    step({ kind: 'opened' })
  }

  return {
    finished,
    draw,
    open,
    step,
    finish,
    fail,
    reportFault,
    drain: () => drainWithin(chain, deps.quitDrainTimeoutMs ?? QUIT_DRAIN_TIMEOUT_MS),
    exitCode: () => exitCode,
  }
}

/**
 * Gives the effect in flight a moment to finish before the screen goes away.
 *
 * Bounded, because the effect is a whole CLI command: an operator who pressed
 * `q` while one is talking to a slow store must not be held on the alternate
 * screen for it. The timer is unref'd so it cannot by itself keep the process
 * alive, and cleared so a fast drain does not wait on it.
 */
async function drainWithin(chain: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
    timer.unref()
  })

  try {
    await Promise.race([chain, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

/** Installs every listener the console needs, and answers with their removal. */
function installListeners(deps: ConsoleDeps, loop: ConsoleLoop): () => void {
  const { input, output } = deps.terminal
  const { processEvents, signals } = deps

  const onKeypress = (str: string | undefined, key: ReadlineKey | undefined): void => {
    const event = keyEventOf(str, key)
    if (event !== undefined) loop.step({ kind: 'key', key: event })
  }
  const onResize = (): void => resizeStep(loop, output)
  // In raw mode `Ctrl-C` is an ordinary key the reducer answers, so a signal
  // here always came from outside: a `kill`, or a terminal window closing.
  const onSignal = (): void => loop.finish(EXIT_INTERRUPTED)
  const onCrash = (error: unknown): void => loop.fail(error)
  // A stream error (an EPIPE surfacing asynchronously) is a terminal that is
  // gone, not a bug to report: the console just leaves.
  const onOutputError = (): void => loop.finish(EXIT_INTERRUPTED)

  input.on(KEYPRESS_EVENT, onKeypress)
  output.on(RESIZE_EVENT, onResize)
  output.on(OUTPUT_ERROR_EVENT, onOutputError)
  for (const signal of signals) processEvents.on(signal, onSignal)
  processEvents.on(UNCAUGHT_EXCEPTION_EVENT, onCrash)
  processEvents.on(UNHANDLED_REJECTION_EVENT, onCrash)

  return () => {
    attempt(() => input.removeListener(KEYPRESS_EVENT, onKeypress))
    attempt(() => output.removeListener(RESIZE_EVENT, onResize))
    attempt(() => output.removeListener(OUTPUT_ERROR_EVENT, onOutputError))
    for (const signal of signals) {
      attempt(() => processEvents.removeListener(signal, onSignal))
    }
    attempt(() => processEvents.removeListener(UNCAUGHT_EXCEPTION_EVENT, onCrash))
    attempt(() => processEvents.removeListener(UNHANDLED_REJECTION_EVENT, onCrash))
  }
}

function resizeStep(loop: ConsoleLoop, output: TuiOutput): void {
  loop.step({ kind: 'resize', size: sizeOf(output) })
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Writes a line, or gives up: a fault report must not become a fault. */
function writeSafely(stream: CliWritable, text: string): void {
  attempt(() => stream.write(text))
}

/** The fault as it should be read afterwards: with its stack when it has one. */
function describeFault(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : messageOf(error)
}
