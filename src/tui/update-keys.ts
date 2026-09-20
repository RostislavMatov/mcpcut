import { PENDING_KEYS_MAX } from './constants-live.js'
import type { KeyEvent } from './keys.js'
import type { Effect, MainScreen, Model, Step } from './model.js'
import { withMain } from './update-step.js'

/**
 * The keys pressed while a run is in flight (mcpcut phase 6, F5 / Q30).
 *
 * The buffer lives IN THE MODEL rather than in the runtime, and that is the
 * decision this module exists for. Kept by the runtime it would be a second
 * piece of state the frame cannot see and the reducer cannot be asked about;
 * kept on the screen it is one more field `withMain` threads, the footer can
 * say "keys are queued" from the same fact the reducer acts on, and every
 * rule below — how many are kept, when they are replayed, when they are
 * thrown away — is a pure function a test can call without a terminal.
 *
 * Two rules the buffer keeps. It holds the FIRST `PENDING_KEYS_MAX` presses:
 * a `1 Tab Enter` typed ahead is a plan, and a plan with its head cut off is
 * worse than none. And it is never replayed into a screen holding a one-time
 * token: `y` there means "I saved it", and nothing typed blind may say so
 * (plan P2 is older than Q30).
 *
 * A leaf: the fold takes the key reducer as a parameter so that this module
 * needs nothing from `update-main.ts`, which is what lets that module call it.
 */

/** The main screen's key reducer, as `replayPending` is handed it. */
export type ApplyKey = (model: Model, screen: MainScreen, key: KeyEvent) => Step

/** Appends a key pressed during a run; the buffer keeps the FIRST `PENDING_KEYS_MAX` (F5). */
export function appendPending(
  pending: readonly KeyEvent[] | undefined,
  key: KeyEvent,
): readonly KeyEvent[] {
  const current = pending ?? []

  return current.length >= PENDING_KEYS_MAX ? current : [...current, key]
}

/**
 * Replays `pending` through `apply`, in order, folding the effects onto the
 * step's own. Feeding stops, with the REST re-queued on the screen, as soon as
 * a replayed key has put a run in flight — a second Enter must wait for the
 * first one's answer exactly as a typed one would — and stops for good when a
 * key has asked to leave the console or the screen is no longer the main one.
 * The step comes back untouched when its screen holds a token.
 */
export function replayPending(step: Step, pending: readonly KeyEvent[], apply: ApplyKey): Step {
  const { screen } = step.model
  if (pending.length === 0 || screen.kind !== 'main' || screen.pane.kind === 'token-hold') {
    return step
  }

  let current = step
  for (const [index, key] of pending.entries()) {
    const now = current.model.screen
    if (now.kind !== 'main' || current.effects.some(leavesConsole)) return current
    if (now.busy !== undefined) return requeued(current, now, pending.slice(index))

    const next = apply(current.model, now, key)
    current = { model: next.model, effects: [...current.effects, ...next.effects] }
  }

  return current
}

/** The step with the keys nobody has fed yet put back on the screen for the next answer. */
function requeued(step: Step, screen: MainScreen, rest: readonly KeyEvent[]): Step {
  return withMain(step.model, screen, { pendingKeys: rest }, step.effects)
}

/**
 * An effect after which no key may be fed: `quit` hands the model back as it
 * stands, so the screen alone cannot tell that the console is leaving, and a
 * `reopen` ends the console for a child process the same way — as does
 * `disconnect`, which is a `reopen` onto the connect form.
 */
function leavesConsole(effect: Effect): boolean {
  return effect.kind === 'quit' || effect.kind === 'reopen' || effect.kind === 'disconnect'
}
