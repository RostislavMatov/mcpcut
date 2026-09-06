import { actionAt, visibleActions } from './catalogue/index.js'
import type { ActionSpec } from './catalogue/types.js'
import { EXIT_OK, SESSION_LOST_NOTICE } from './constants.js'
import { formOf } from './form.js'
import type { KeyEvent } from './keys.js'
import type { Effect, Model, Msg, Pane, Step } from './model.js'
import { type OutputPanel, outputPanelOf, scrollOutput, scrollToEnd, scrollToStart } from './output.js'
import { isYes, submit, updateConfirmPane, updateFormPane, requestOf } from './update-form.js'
import { signedOut } from './update-signin.js'
import {
  ACTIONS_PANE,
  type MainScreen,
  noEffects,
  pageRowsOf,
  quit,
  withMain,
} from './update-step.js'

/**
 * The main screen (mcpcut phase 2, Task 9): sections, the actions under them,
 * the output of the last run, and the two panes that interrupt all of it.
 *
 * Every cursor move is clamped rather than trusted. `sections` is already
 * filtered by role when the screen is built, but an index into it is still
 * checked here — this is the module that turns a keystroke into a command
 * line, and it must answer the same way whichever screen it is handed.
 */

/** Keys that do something other than move a cursor. */
const REFRESH_KEY = 'r'
const HELP_KEY = '?'
const QUIT_KEY = 'q'

/** The digits that name a section, and what `1` maps to. */
const FIRST_SECTION_DIGIT = 1
const LAST_SECTION_DIGIT = 9

const HELP_PANE: Pane = { kind: 'help' }
const QUIT_CONFIRM_PANE: Pane = { kind: 'quit-confirm' }
const REFRESH_SERVICES: Effect = { kind: 'refresh-services' }

/** Folds one message into the main screen. */
export function updateMain(model: Model, screen: MainScreen, msg: Msg): Step {
  switch (msg.kind) {
    case 'key':
      return applyKey(model, screen, msg.key)
    case 'run-result':
      return withMain(model, screen, {
        pane: ACTIONS_PANE,
        busy: undefined,
        output: outputPanelOf(msg.result),
      })
    case 'services':
      return withMain(model, screen, { services: msg.statuses })
    case 'session-lost':
      return noEffects(signedOut(model.size, SESSION_LOST_NOTICE))
    default:
      // `signin-result` belongs to a sign-in this screen already replaced, and
      // `resize` never reaches here (`update.ts` takes it).
      return noEffects(model)
  }
}

function applyKey(model: Model, screen: MainScreen, key: KeyEvent): Step {
  switch (screen.pane.kind) {
    case 'help':
      return withMain(model, screen, { pane: ACTIONS_PANE })
    case 'quit-confirm':
      return isYes(key) ? quit(model, EXIT_OK) : withMain(model, screen, { pane: ACTIONS_PANE })
    case 'form':
      return updateFormPane(model, screen, screen.pane, key)
    case 'confirm':
      return updateConfirmPane(model, screen, screen.pane, key)
    case 'actions':
      return applyActionKey(model, screen, key)
  }
}

function applyActionKey(model: Model, screen: MainScreen, key: KeyEvent): Step {
  const sectionStep = sectionStepOf(key)
  if (sectionStep !== undefined) return movedSection(model, screen, sectionStep)

  const jump = sectionDigitOf(key)
  if (jump !== undefined) return jumpedSection(model, screen, jump)

  const actionStep = actionStepOf(key)
  if (actionStep !== undefined) return movedAction(model, screen, actionStep)

  return applyCommandKey(model, screen, key)
}

function applyCommandKey(model: Model, screen: MainScreen, key: KeyEvent): Step {
  if (key.kind === 'enter') return openAction(model, screen)
  if (isChar(key, REFRESH_KEY)) return refreshSection(model, screen)
  if (isChar(key, HELP_KEY)) return withMain(model, screen, { pane: HELP_PANE })
  if (isChar(key, QUIT_KEY)) return requestQuit(model, screen)

  return scrolled(model, screen, key)
}

/** Which way a key moves the section cursor, if it moves it at all. */
function sectionStepOf(key: KeyEvent): number | undefined {
  if (key.kind === 'tab' || key.kind === 'right' || isChar(key, 'l')) return 1
  if (key.kind === 'backtab' || key.kind === 'left' || isChar(key, 'h')) return -1

  return undefined
}

/** Which way a key moves the action cursor, if it moves it at all. */
function actionStepOf(key: KeyEvent): number | undefined {
  if (key.kind === 'down' || isChar(key, 'j')) return 1
  if (key.kind === 'up' || isChar(key, 'k')) return -1

  return undefined
}

/** The section a digit names, as an index, or `undefined` for any other key. */
function sectionDigitOf(key: KeyEvent): number | undefined {
  if (key.kind !== 'char' || key.char.length !== 1) return undefined

  const digit = Number(key.char)
  if (!Number.isInteger(digit) || digit < FIRST_SECTION_DIGIT || digit > LAST_SECTION_DIGIT) {
    return undefined
  }

  return digit - FIRST_SECTION_DIGIT
}

function isChar(key: KeyEvent, char: string): boolean {
  return key.kind === 'char' && key.char === char
}

/** Moves to the next or previous section, wrapping; the action cursor resets. */
function movedSection(model: Model, screen: MainScreen, step: number): Step {
  const count = screen.sections.length
  if (count === 0) return noEffects(model)

  const sectionIndex = (screen.sectionIndex + step + count) % count
  return withMain(model, screen, { sectionIndex, actionIndex: 0 })
}

function jumpedSection(model: Model, screen: MainScreen, sectionIndex: number): Step {
  if (sectionIndex >= screen.sections.length) return noEffects(model)

  return withMain(model, screen, { sectionIndex, actionIndex: 0 })
}

/** Moves the action cursor, stopping at both ends rather than wrapping. */
function movedAction(model: Model, screen: MainScreen, step: number): Step {
  const last = Math.max(0, visibleActionsOf(screen).length - 1)
  const actionIndex = Math.min(Math.max(0, screen.actionIndex + step), last)

  return actionIndex === screen.actionIndex ? noEffects(model) : withMain(model, screen, { actionIndex })
}

function visibleActionsOf(screen: MainScreen): readonly ActionSpec[] {
  const section = screen.sections[screen.sectionIndex]
  return section === undefined ? [] : visibleActions(section, screen.session.role)
}

/** Opens the selected action: a form when it has fields, the command when it has none. */
function openAction(model: Model, screen: MainScreen): Step {
  const action = actionAt(
    screen.sections,
    screen.session.role,
    screen.sectionIndex,
    screen.actionIndex,
  )
  if (action === undefined) return noEffects(model)
  if (action.fields.length === 0) return submit(model, screen, action, {})

  const pane: Pane = { kind: 'form', actionId: action.id, form: formOf(action.fields) }
  return withMain(model, screen, { pane })
}

/**
 * `r` reads the section again: it reruns the action the section names as its
 * refresh (`admin list`, `status`) AND asks for a fresh service line, because
 * the header is on every screen. A section with no such action still refreshes
 * the header — that is the half of the key that always applies.
 */
function refreshSection(model: Model, screen: MainScreen): Step {
  const action = refreshActionOf(screen)
  if (action === undefined) return { model, effects: [REFRESH_SERVICES] }

  const request = requestOf(action, {})
  return withMain(model, screen, { pane: ACTIONS_PANE, busy: request }, [
    { kind: 'run', request },
    REFRESH_SERVICES,
  ])
}

/**
 * The section's refresh action, when it names one this role may run and that
 * needs no arguments. An action with fields cannot be rerun by one keystroke:
 * there would be nothing to fill them with.
 */
function refreshActionOf(screen: MainScreen): ActionSpec | undefined {
  const refreshActionId = screen.sections[screen.sectionIndex]?.refreshActionId
  if (refreshActionId === undefined) return undefined

  const action = visibleActionsOf(screen).find((each) => each.id === refreshActionId)
  return action !== undefined && action.fields.length === 0 ? action : undefined
}

/**
 * `q` leaves at once, unless the screen holds a token that leaves with it: the
 * alternate screen takes its scrollback along, and a one-time token shown once
 * is gone for good (PRD C6).
 */
function requestQuit(model: Model, screen: MainScreen): Step {
  return screen.output?.holdsOneTimeToken === true
    ? withMain(model, screen, { pane: QUIT_CONFIRM_PANE })
    : quit(model, EXIT_OK)
}

function scrolled(model: Model, screen: MainScreen, key: KeyEvent): Step {
  const { output } = screen
  if (output === undefined) return noEffects(model)

  const scrolledPanel = scrolledOutput(output, key, pageRowsOf(model.size))
  return scrolledPanel === undefined ? noEffects(model) : withMain(model, screen, { output: scrolledPanel })
}

function scrolledOutput(
  panel: OutputPanel,
  key: KeyEvent,
  pageRows: number,
): OutputPanel | undefined {
  switch (key.kind) {
    case 'pagedown':
      return scrollOutput(panel, pageRows, pageRows)
    case 'pageup':
      return scrollOutput(panel, -pageRows, pageRows)
    case 'home':
      return scrollToStart(panel)
    case 'end':
      return scrollToEnd(panel, pageRows)
    default:
      return undefined
  }
}
