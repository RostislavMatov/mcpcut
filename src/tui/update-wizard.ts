import { EXIT_OK, wizardFailedNotice } from './constants.js'
import { applyFormKey, isValid, validateForm, valuesOf } from './form.js'
import type { KeyEvent } from './keys.js'
import type {
  Model,
  Msg,
  RunRequest,
  Step,
  TerminalSize,
  WizardScreen,
  WizardStage,
} from './model.js'
import { type OutputPanel, scrollOutput, scrollToEnd, scrollToStart } from './output.js'
import { isYes } from './update-form.js'
import { noEffects, pageRowsOf, quit, withScreen } from './update-step.js'
import { applyRunResult, countWaitedTick } from './update-wizard-deploy.js'
import {
  exposureWarningsOf,
  initialDeploySteps,
  requestOf as stepRequestOf,
} from './wizard-fields.js'

/**
 * The first-run wizard's reducer (mcpcut phase 3, Task 3): five stages and a
 * chain of three commands, all of it a pure `(model, msg) → step` like the
 * rest of the console's core.
 *
 * The chain is the shape worth naming. One rung asks the runtime for ONE
 * command (`wizard-run`), the runtime answers with ONE message, and the answer
 * carries the effect that opens the next rung — so the ladder can only ever
 * have one step in flight, a result that arrives after the operator left
 * (Ctrl-C) lands on a stage that is no longer `deploying` and is dropped, and
 * the whole deploy is asserted keystroke by keystroke without dispatching
 * anything. What each finished rung does is `update-wizard-deploy.ts`.
 *
 * Two rules the stages exist to keep. Nothing is written before the exposure
 * question is answered: a bind the network can reach goes through
 * `confirm-exposure`, and `n` returns to the form with the install still
 * untouched. And the token `setup` minted rides in the model from the moment
 * that rung finishes until the final screen shows it — it is carried by the
 * `deploying` stage, which draws no token in any frame, because by the time
 * the wizard is done `setup`'s transcript has been pushed out by the starts.
 */

type ExposureStage = Extract<WizardStage, { kind: 'confirm-exposure' }>
type DeployingStage = Extract<WizardStage, { kind: 'deploying' }>
type FailedStage = Extract<WizardStage, { kind: 'setup-failed' }>
type DoneStage = Extract<WizardStage, { kind: 'done' }>

/** The answer that leaves a screen without a question to answer. */
const QUIT_CHAR = 'q'

/** Folds one message into the wizard. */
export function updateWizard(model: Model, screen: WizardScreen, msg: Msg): Step {
  if (msg.kind === 'key') return applyKey(model, screen, msg.key)
  if (msg.kind === 'wizard-run-result') return applyRunResult(model, screen, msg.step, msg.result)
  if (msg.kind === 'tick') return countWaitedTick(model, screen)

  // `signin-result`, `run-result`, `services` and `session-lost` all belong to
  // a console session; the wizard runs before there is one.
  return noEffects(model)
}

function applyKey(model: Model, screen: WizardScreen, key: KeyEvent): Step {
  const { stage } = screen
  switch (stage.kind) {
    case 'form':
      return onFormKey(model, screen, key)
    case 'confirm-exposure':
      return onExposureKey(model, screen, stage, key)
    case 'deploying':
      return onDeployingKey(model, screen, stage, key)
    case 'setup-failed':
      return onFailedKey(model, screen, stage, key)
    case 'done':
      return onDoneKey(model, screen, stage, key)
  }
}

/**
 * `Esc` leaves with 0 rather than going back: the wizard is the first screen
 * of a fresh install, so there is nowhere behind it. `q` is a letter here —
 * it belongs in a field, and the footer says so.
 */
function onFormKey(model: Model, screen: WizardScreen, key: KeyEvent): Step {
  if (key.kind === 'escape') return quit(model, EXIT_OK)
  if (key.kind === 'enter') return submitForm(model, screen)

  const form = applyFormKey(screen.form, key)
  // An edit answers the notice a failed deploy left, so the notice goes.
  return form === screen.form
    ? noEffects(model)
    : withScreen(model, { ...screen, form, stage: { kind: 'form' } })
}

/**
 * Validates every answer, then either shows what is wrong, asks about a bind
 * the network can reach, or starts the deploy. The verdict is kept on the
 * screen (`form`) so the errors drawn are the errors of the values drawn.
 */
function submitForm(model: Model, screen: WizardScreen): Step {
  const form = validateForm(screen.form)
  if (!isValid(form)) return withScreen(model, { ...screen, form })

  const values = valuesOf(form)
  const request = stepRequestOf('setup', values)
  const warnings = exposureWarningsOf(values)
  const validated: WizardScreen = { ...screen, form }
  if (warnings.length === 0) return beginDeploy(model, validated, request)

  return withScreen(model, {
    ...validated,
    stage: { kind: 'confirm-exposure', request, warnings },
  })
}

/** Puts `setup` in flight; the rungs below it are opened by its answer. */
function beginDeploy(model: Model, screen: WizardScreen, request: RunRequest): Step {
  const stage: WizardStage = { kind: 'deploying', steps: initialDeploySteps() }

  return withScreen(model, { ...screen, stage }, [{ kind: 'wizard-run', step: 'setup', request }])
}

/** Yes runs the command the question was about; anything else is no. */
function onExposureKey(
  model: Model,
  screen: WizardScreen,
  stage: ExposureStage,
  key: KeyEvent,
): Step {
  if (isYes(key)) return beginDeploy(model, screen, stage.request)

  return withScreen(model, { ...screen, stage: { kind: 'form' } })
}

/**
 * A step is in flight: the keyboard does nothing but scroll the transcript.
 * `Ctrl-C` never reaches here — `update.ts` answers it before the routing.
 */
function onDeployingKey(
  model: Model,
  screen: WizardScreen,
  stage: DeployingStage,
  key: KeyEvent,
): Step {
  const output = scrolledPanel(stage.output, key, model.size)
  if (output === undefined) return noEffects(model)

  return withScreen(model, { ...screen, stage: { ...stage, output } })
}

/** Enter retries with the answers as they stand; `q` and `Esc` leave. */
function onFailedKey(model: Model, screen: WizardScreen, stage: FailedStage, key: KeyEvent): Step {
  if (key.kind === 'enter') {
    const notice = wizardFailedNotice(stage.output.exitCode)
    return withScreen(model, { ...screen, stage: { kind: 'form', notice } })
  }
  if (isQuitKey(key)) return quit(model, EXIT_OK)

  const output = scrolledPanel(stage.output, key, model.size)
  if (output === undefined) return noEffects(model)

  return withScreen(model, { ...screen, stage: { ...stage, output } })
}

/**
 * The final screen. While the one copy of the owner token is on it, `q` asks
 * first: the alternate screen takes its scrollback along, and a token shown
 * once is gone for good (PRD C6). With no token there is nothing to lose, so
 * `Enter` signs in and `q` leaves at once.
 */
function onDoneKey(model: Model, screen: WizardScreen, stage: DoneStage, key: KeyEvent): Step {
  if (stage.quitAsked) {
    if (isYes(key)) return quit(model, EXIT_OK)
    return withScreen(model, { ...screen, stage: { ...stage, quitAsked: false } })
  }

  const holdsToken = stage.admin !== undefined
  const signsIn = holdsToken ? isYes(key) : key.kind === 'enter'
  if (signsIn) return finish(model, screen)
  if (!isQuitKey(key)) return noEffects(model)

  return holdsToken
    ? withScreen(model, { ...screen, stage: { ...stage, quitAsked: true } })
    : quit(model, EXIT_OK)
}

/** Hands the terminal back so the runtime can reopen the console signed out. */
function finish(model: Model, screen: WizardScreen): Step {
  return withScreen(model, screen, [
    { kind: 'wizard-finish' },
    { kind: 'quit', exitCode: EXIT_OK },
  ])
}

function isQuitKey(key: KeyEvent): boolean {
  return key.kind === 'escape' || (key.kind === 'char' && key.char === QUIT_CHAR)
}

/** The transcript moved by a scrolling key, or nothing when the key was not one. */
function scrolledPanel(
  output: OutputPanel | undefined,
  key: KeyEvent,
  size: TerminalSize,
): OutputPanel | undefined {
  if (output === undefined) return undefined

  const pageRows = pageRowsOf(size)
  switch (key.kind) {
    case 'pagedown':
      return scrollOutput(output, pageRows, pageRows)
    case 'pageup':
      return scrollOutput(output, -pageRows, pageRows)
    case 'home':
      return scrollToStart(output)
    case 'end':
      return scrollToEnd(output, pageRows)
    default:
      return undefined
  }
}
