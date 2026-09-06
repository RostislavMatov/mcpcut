import { visibleActions } from './catalogue/index.js'
import type { ActionSpec } from './catalogue/types.js'
import {
  editFocused,
  focusNext,
  focusPrevious,
  type Form,
  type FormValues,
  isValid,
  validateForm,
  valuesOf,
} from './form.js'
import type { KeyEvent } from './keys.js'
import type { Model, Pane, RunRequest, Step } from './model.js'
import { ACTIONS_PANE, type MainScreen, noEffects, withMain } from './update-step.js'

/**
 * The two panes that stand between a chosen action and a running command
 * (mcpcut phase 2, Task 9): the form that collects its arguments, and the
 * question some actions ask before anything happens.
 *
 * `submit` is the ONLY place a `RunRequest` is built, and it is shared with
 * the action list (an action with no fields runs straight from `Enter`, and
 * `r` reruns a section's refresh action). One builder means the command line
 * the output pane prints is by construction the command line that ran.
 */

export type FormPane = Extract<Pane, { kind: 'form' }>
export type ConfirmPane = Extract<Pane, { kind: 'confirm' }>

/** The answers that mean yes at a confirmation. */
const YES_ANSWERS: readonly string[] = ['y', 'Y']

/** Whether a keystroke answers a question with yes; anything else is no. */
export function isYes(key: KeyEvent): boolean {
  return key.kind === 'char' && YES_ANSWERS.includes(key.char)
}

/**
 * Turns an action and the values it was given into the request the runtime
 * dispatches. `display` is a COPY of `argv` — the panel keeps it beside the
 * output, and a later phase masks a secret in the copy while the original is
 * what was actually run.
 */
export function requestOf(action: ActionSpec, values: FormValues): RunRequest {
  const argv = action.argv(values)
  return { actionId: action.id, argv, display: [...argv] }
}

/** Runs an action, or asks the question it insists on first. */
export function submit(
  model: Model,
  screen: MainScreen,
  action: ActionSpec,
  values: FormValues,
): Step {
  const request = requestOf(action, values)
  if (action.confirm !== undefined) {
    const pane: Pane = {
      kind: 'confirm',
      actionId: action.id,
      request,
      question: action.confirm(values),
    }
    return withMain(model, screen, { pane })
  }

  return withMain(model, screen, { pane: ACTIONS_PANE, busy: request }, [{ kind: 'run', request }])
}

/** Folds one keystroke into an open form. */
export function updateFormPane(
  model: Model,
  screen: MainScreen,
  pane: FormPane,
  key: KeyEvent,
): Step {
  if (key.kind === 'escape') return withMain(model, screen, { pane: ACTIONS_PANE })
  if (key.kind === 'enter') return runForm(model, screen, pane)

  const form = movedFocus(pane.form, key) ?? editFocused(pane.form, key)
  return form === pane.form ? noEffects(model) : withMain(model, screen, { pane: { ...pane, form } })
}

/** The focus keys, or `undefined` when the keystroke is the field's business. */
function movedFocus(form: Form, key: KeyEvent): Form | undefined {
  if (key.kind === 'tab' || key.kind === 'down') return focusNext(form)
  if (key.kind === 'backtab' || key.kind === 'up') return focusPrevious(form)

  return undefined
}

/**
 * Validates the whole form and either shows what is wrong with it or runs it.
 * The action is looked up by the id the pane carries rather than by the
 * cursor, so a form always builds the command it was opened for.
 */
function runForm(model: Model, screen: MainScreen, pane: FormPane): Step {
  const action = actionOf(screen, pane.actionId)
  if (action === undefined) return withMain(model, screen, { pane: ACTIONS_PANE })

  const form = validateForm(pane.form)
  if (!isValid(form)) return withMain(model, screen, { pane: { ...pane, form } })

  return submit(model, screen, action, valuesOf(form))
}

function actionOf(screen: MainScreen, actionId: string): ActionSpec | undefined {
  const section = screen.sections[screen.sectionIndex]
  if (section === undefined) return undefined

  return visibleActions(section, screen.session.role).find((action) => action.id === actionId)
}

/** Folds one keystroke into a confirmation: yes runs it, anything else cancels. */
export function updateConfirmPane(
  model: Model,
  screen: MainScreen,
  pane: ConfirmPane,
  key: KeyEvent,
): Step {
  if (!isYes(key)) return withMain(model, screen, { pane: ACTIONS_PANE })

  return withMain(model, screen, { pane: ACTIONS_PANE, busy: pane.request }, [
    { kind: 'run', request: pane.request },
  ])
}
