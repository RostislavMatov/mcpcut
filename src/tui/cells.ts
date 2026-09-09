/**
 * The runtime's deliberately mutable cells (phase 5, task 1).
 *
 * A cell is the one channel an effect has that is not a `Msg`: a value the
 * runtime reads AFTER `runConsole` has given the terminal back, when there is
 * no model left to fold it into. The session token is one (it is kept out of
 * the model so no frame can draw it — ADR-0004), the wizard's answer is
 * another, and phase 5's reopen argv is the third.
 *
 * The value lives in the closure and is reachable only through `get`, so
 * nothing can enumerate, serialize or clone it by accident. That mattered for
 * one cell and now holds for all three, which is why the shape is generic here
 * rather than written out once per cell — `runtime-effects.ts` re-exports the
 * lot, so its importers never learned that this file exists.
 */

/** One value, held outside the model, written by an effect and read by the runtime. */
export interface Cell<T> {
  get(): T | undefined
  set(value: T | undefined): void
}

/** A fresh, empty cell. */
export function createCell<T>(): Cell<T> {
  let value: T | undefined
  return {
    get: () => value,
    set: (next: T | undefined) => {
      value = next
    },
  }
}

/** The one intentionally mutable cell of the runtime: the signed-in token. */
export type TokenCell = Cell<string>

export function createTokenCell(): TokenCell {
  return createCell<string>()
}

/**
 * What the wizard asked the runtime for once its last screen is done. One
 * value — the operator wants the sign-in screen — and a named type rather
 * than a boolean, so that a second answer is an addition rather than a
 * re-reading of `true`. Phase 5's second answer turned out NOT to belong here:
 * "leave the console and run this argv on the same terminal" is asked by an
 * ACTION, not by the wizard, so it became a cell of its own below.
 */
export type WizardOutcome = 'sign-in'

/** The wizard's own cell: the single channel out of an effect. */
export type WizardOutcomeCell = Cell<WizardOutcome>

export function createWizardOutcomeCell(): WizardOutcomeCell {
  return createCell<WizardOutcome>()
}

/**
 * Where an action that leaves the console puts the argv the runtime is to
 * reopen with, on the same terminal, once the console has restored it.
 */
export type ReopenCell = Cell<readonly string[]>

export function createReopenCell(): ReopenCell {
  return createCell<readonly string[]>()
}
