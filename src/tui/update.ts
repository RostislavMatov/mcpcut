import { EXIT_OK } from './constants.js'
import type { KeyEvent } from './keys.js'
import type { Model, Msg, Step } from './model.js'
import { appendPending } from './update-keys.js'
import { updateMain } from './update-main.js'
import { updateSignin } from './update-signin.js'
import { noEffects, quit, withMain } from './update-step.js'
import { updateWizard } from './update-wizard.js'

/**
 * The console's reducer (mcpcut phase 2, Task 9): one pure function from a
 * model and a message to the next model and the effects it asks for. Nothing
 * here reads a terminal, a store or a clock, which is what lets every screen
 * and every exit path be asserted without one.
 *
 * This module holds only what is true on EVERY screen — a resize, the
 * interrupt key, and the rule that a run in flight defers the keyboard — and
 * hands the rest to `update-signin.ts`, `update-wizard.ts` and
 * `update-main.ts`.
 */

/** In raw mode `Ctrl-C` is an ordinary key: no `SIGINT` arrives, so we answer it. */
const INTERRUPT_KEY = 'c'

export function update(model: Model, msg: Msg): Step {
  // A resize is not a keystroke and applies mid-run: the frame drawn after it
  // must fit the terminal that exists now, whatever else is going on.
  if (msg.kind === 'resize') return noEffects({ ...model, size: msg.size })
  if (msg.kind === 'key' && isInterrupt(msg.key)) return quit(model, EXIT_OK)

  const { screen } = model
  if (screen.kind === 'signin') return updateSignin(model, screen, msg)

  if (screen.kind === 'wizard') return updateWizard(model, screen, msg)

  // A command is running: the keyboard is DEFERRED, not deaf (phase 6, F5).
  // Each key is queued on the screen and replayed, in order, once the run
  // answers — so a second Enter still cannot start a second run behind the
  // first, but a `2 Tab` typed ahead is not lost either. Ctrl-C above still
  // leaves at once, and the queue is not replayed on the way out. Only a KEY
  // is queued — `tick`, `poll-result` and `opened` reach the main reducer,
  // which drops what it must itself: a tick during a run is nothing to do,
  // while a poll answering during one still has a `polling` flag to clear,
  // and swallowing it here would leave the timer down for good.
  if (msg.kind === 'key' && screen.busy !== undefined) {
    return withMain(model, screen, { pendingKeys: appendPending(screen.pendingKeys, msg.key) })
  }

  return updateMain(model, screen, msg)
}

function isInterrupt(key: KeyEvent): boolean {
  return key.kind === 'ctrl' && key.char === INTERRUPT_KEY
}
