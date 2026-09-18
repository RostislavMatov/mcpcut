import { actionAt, refreshActionOf, visibleActions } from './catalogue/index.js'
import type { ActionSpec } from './catalogue/types.js'
import { EXIT_OK, SESSION_LOST_NOTICE } from './constants.js'
import { formOf } from './form.js'
import type { KeyEvent } from './keys.js'
import { paneWidthOf } from './layout.js'
import type { Effect, Model, Msg, Pane, Step } from './model.js'
import {
  acknowledgeToken,
  needsTokenHold,
  type OutputPanel,
  outputPanelOf,
  scrollOutput,
  scrollOutputSideways,
  scrollToEnd,
  scrollToStart,
} from './output.js'
import {
  effectOf,
  isYes,
  submit,
  updateConfirmPane,
  updateFormPane,
  requestOf,
} from './update-form.js'
import { replayPending } from './update-keys.js'
import { updateLive } from './update-live.js'
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

/**
 * The two keys that move the output pane sideways (owner tail Q24). `←`/`→`
 * were already spoken for by the section bar, so the pane borrows the pair a
 * pager would use.
 */
const SCROLL_LEFT_KEY = '['
const SCROLL_RIGHT_KEY = ']'

/** The digits that name a section, and what `1` maps to. */
const FIRST_SECTION_DIGIT = 1
const LAST_SECTION_DIGIT = 9

const HELP_PANE: Pane = { kind: 'help' }
const QUIT_CONFIRM_PANE: Pane = { kind: 'quit-confirm' }
const TOKEN_HOLD_PANE: Pane = { kind: 'token-hold' }
const REFRESH_SERVICES: Effect = { kind: 'refresh-services' }

/** Folds one message into the main screen. */
export function updateMain(model: Model, screen: MainScreen, msg: Msg): Step {
  switch (msg.kind) {
    case 'key':
      return applyKey(model, screen, msg.key)
    case 'run-result': {
      // A run that minted a one-time token does not return to the action list:
      // the next `r`, Enter or poll would take the only copy of it away, so the
      // pane holds until somebody says they saved it (PRD C6, plan P2).
      const panel = outputPanelOf(msg.result)
      const answered = withMain(model, screen, {
        pane: panel.holdsOneTimeToken ? TOKEN_HOLD_PANE : ACTIONS_PANE,
        busy: undefined,
        output: panel,
        pendingKeys: undefined,
      })

      // The keys typed during the run are fed to the screen the answer built
      // (phase 6, F5); `replayPending` feeds none into a token hold — the
      // queue is already gone from the screen, and the fold leaves it gone.
      return replayPending(answered, screen.pendingKeys ?? [], applyKey)
    }
    case 'services':
      return withMain(model, screen, { services: msg.statuses })
    case 'session-lost':
      // The install is a fact about the host, not about the session: it must
      // survive back to the sign-in screen, which draws the services line.
      // That line is asked for again here, exactly as `opened` asks for it:
      // the answer the main screen had belonged to the session that has just
      // gone, and the screen an operator is dropped onto should still say
      // whether the daemons are up (plan P3).
      return {
        model: signedOut(model.size, SESSION_LOST_NOTICE, model.install),
        effects: [REFRESH_SERVICES],
      }
    case 'opened':
    case 'tick':
    case 'poll-result':
      return updateLive(model, screen, msg)
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
      // Not answering yes returns to where the question was asked FROM: a token
      // still unsaved is still being held, and dropping to the action list
      // would be the console quietly deciding it had been read.
      return isYes(key)
        ? quit(model, EXIT_OK)
        : withMain(model, screen, {
            pane: needsTokenHold(screen.output) ? TOKEN_HOLD_PANE : ACTIONS_PANE,
          })
    case 'token-hold':
      return applyTokenHoldKey(model, screen, key)
    case 'form':
      return updateFormPane(model, screen, screen.pane, key)
    case 'confirm':
      return updateConfirmPane(model, screen, screen.pane, key)
    case 'actions':
      return applyActionKey(model, screen, key)
  }
}

/**
 * Nothing leaves the token behind unread: `y` says it is saved, `q` asks,
 * scrolling works, and every other key is dropped (`scrolled` answers a
 * no-effect step for anything that does not move the pane).
 */
function applyTokenHoldKey(model: Model, screen: MainScreen, key: KeyEvent): Step {
  if (isYes(key)) {
    return withMain(model, screen, {
      pane: ACTIONS_PANE,
      output: screen.output === undefined ? undefined : acknowledgeToken(screen.output),
    })
  }
  if (isChar(key, QUIT_KEY)) return withMain(model, screen, { pane: QUIT_CONFIRM_PANE })

  return scrolled(model, screen, key)
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

/**
 * What a section switch does to the pane: it CLEARS it, so the new section
 * opens on its own introduction exactly as it does on first entry.
 *
 * The output belongs to the section that filled it, and carrying it across made
 * the Journal tab show `$ mcpcut approvals list` until something was run there
 * (user-journey smoke 2026-09-18, UX-10). This is not the case ADR-0012 §21
 * protects: there the operator must not lose an error to a BACKGROUND poll,
 * whereas leaving a tab is their own act.
 *
 * Two things are never dropped. A one-time token that nobody has said they
 * saved stays (navigation cannot reach here while the `token-hold` pane is up —
 * ADR-0012 §22 — and this is the second half of the same rule); and a run in
 * flight cannot be navigated away from at all, since keys are queued while
 * `busy` is set (`update-keys.ts`).
 */
function withSection(model: Model, screen: MainScreen, sectionIndex: number): Step {
  const keepOutput = needsTokenHold(screen.output) || screen.busy !== undefined
  return withMain(model, screen, {
    sectionIndex,
    actionIndex: 0,
    ...(keepOutput ? {} : { output: undefined }),
  })
}

/** Moves to the next or previous section, wrapping; the action cursor resets. */
function movedSection(model: Model, screen: MainScreen, step: number): Step {
  const count = screen.sections.length
  if (count === 0) return noEffects(model)

  return withSection(model, screen, (screen.sectionIndex + step + count) % count)
}

function jumpedSection(model: Model, screen: MainScreen, sectionIndex: number): Step {
  if (sectionIndex >= screen.sections.length) return noEffects(model)

  return withSection(model, screen, sectionIndex)
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
 *
 * The effect comes from `effectOf`, the one place the `reopen` arm is honoured,
 * rather than from a `{ kind: 'run' }` literal: a request that would leave the
 * console must never be dispatched in-process. `refreshActionOf` already
 * refuses such an action, so this is the second half of the same rule — one
 * builder means the two cannot disagree.
 */
function refreshSection(model: Model, screen: MainScreen): Step {
  const action = refreshActionOf(screen.sections, screen.session.role, screen.sectionIndex)
  if (action === undefined) return { model, effects: [REFRESH_SERVICES] }

  const request = requestOf(action, {})
  return withMain(model, screen, { pane: ACTIONS_PANE, busy: request }, [
    effectOf(request),
    REFRESH_SERVICES,
  ])
}

/**
 * `q` leaves at once, unless the screen holds a token that leaves with it: the
 * alternate screen takes its scrollback along, and a one-time token shown once
 * is gone for good (PRD C6).
 */
function requestQuit(model: Model, screen: MainScreen): Step {
  return needsTokenHold(screen.output)
    ? withMain(model, screen, { pane: QUIT_CONFIRM_PANE })
    : quit(model, EXIT_OK)
}

function scrolled(model: Model, screen: MainScreen, key: KeyEvent): Step {
  const { output } = screen
  if (output === undefined) return noEffects(model)

  const scrolledPanel = scrolledOutput(output, key, model)
  if (scrolledPanel === undefined || scrolledPanel === output) return noEffects(model)

  return withMain(model, screen, { output: scrolledPanel })
}

function scrolledOutput(panel: OutputPanel, key: KeyEvent, model: Model): OutputPanel | undefined {
  const pageRows = pageRowsOf(model.size)
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
      return sideScrolledOutput(panel, key, paneWidthOf(model.size.columns))
  }
}

/** `[` and `]`, clamped by the panel to the columns its own text occupies. */
function sideScrolledOutput(
  panel: OutputPanel,
  key: KeyEvent,
  paneWidth: number,
): OutputPanel | undefined {
  if (isChar(key, SCROLL_RIGHT_KEY)) return scrollOutputSideways(panel, 1, paneWidth)
  if (isChar(key, SCROLL_LEFT_KEY)) return scrollOutputSideways(panel, -1, paneWidth)

  return undefined
}
