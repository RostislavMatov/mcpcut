import { ADMIN_TOKEN_PREFIX } from '../admin/constants.js'
import { START_READY_TIMEOUT_MS } from '../services/constants.js'
import { sanitizeLine } from './ansi.js'
import {
  DEPLOY_EXTERNAL_DETAIL,
  DEPLOY_SETUP_DONE_DETAIL,
  DEPLOY_SETUP_DONE_WITH_OWNER_DETAIL,
  DEPLOY_TOKEN_PLACEHOLDER,
  deployExitDetail,
  deployWaitingDetail,
} from './constants.js'
import { type FormValues, valuesOf } from './form.js'
import type {
  DeployStep,
  DeployStepId,
  DeployStepState,
  MintedAdmin,
  Model,
  Step,
  WizardScreen,
  WizardStage,
} from './model.js'
import { outputPanelOf, type OutputPanel, type RunResult, scrollToEnd } from './output.js'
import { isWaitingOnStart } from './subscriptions.js'
import { noEffects, pageRowsOf, withScreen } from './update-step.js'
import {
  isExternalSupervisor,
  mintedAdminOf,
  requestOf as stepRequestOf,
} from './wizard-fields.js'

/**
 * The deploy ladder of the first-run wizard (mcpcut phase 3, Task 3): what
 * each of the three rungs does with the result it got, and which command that
 * asks for next.
 *
 * It lives beside `update-wizard.ts` rather than in it because the two halves
 * answer different messages — one folds keystrokes into a stage, this one
 * folds finished commands into the ladder — and together they would be one
 * file over the size the project keeps its modules to.
 */

type DeployingStage = Extract<WizardStage, { kind: 'deploying' }>

/**
 * Folds one finished rung in.
 *
 * A result is answered only where it can belong: on the `deploying` stage, and
 * only when the rung it names is the one in flight. Everything else is a race
 * — a command that answered after Ctrl-C, or a duplicate — and is dropped
 * with the model untouched, so a late answer can never restart the ladder.
 */
export function applyRunResult(
  model: Model,
  screen: WizardScreen,
  step: DeployStepId,
  result: RunResult,
): Step {
  const { stage } = screen
  if (stage.kind !== 'deploying') return noEffects(model)
  if (runningStepOf(stage.steps) !== step) return noEffects(model)

  return step === 'setup'
    ? afterSetup(model, screen, stage, result)
    : afterStart(model, screen, stage, step, result)
}

function runningStepOf(steps: readonly DeployStep[]): DeployStepId | undefined {
  return steps.find((each) => each.state === 'running')?.id
}

/**
 * The stopwatch ticked (phase 6, F8): one more second beside the `start-*`
 * rung being waited on. `isWaitingOnStart` is the SAME question the runtime
 * asked before arming the timer, so a tick that lands on any other stage —
 * `setup` still running, the ladder done, a form — is dropped by the rule
 * that would have stopped the timer. The count is of ticks, not of a clock:
 * the reducer stays pure, and a second of drift is nothing against a wait of
 * `START_READY_TIMEOUT_MS`. The transcript and the minted admin ride along
 * untouched; a fresh rung starts from nothing, because `advance` builds its
 * stage without a count.
 */
export function countWaitedTick(model: Model, screen: WizardScreen): Step {
  const { stage } = screen
  if (stage.kind !== 'deploying' || !isWaitingOnStart(stage)) return noEffects(model)

  const running = runningStepOf(stage.steps)
  if (running === undefined) return noEffects(model)

  const waitedTicks = (stage.waitedTicks ?? 0) + 1
  const detail = deployWaitingDetail(START_READY_TIMEOUT_MS, waitedTicks)
  const steps = markStep(stage.steps, running, 'running', detail)

  return withScreen(model, { ...screen, stage: { ...stage, steps, waitedTicks } })
}

/**
 * Anything shaped like an admin token: the prefix the store mints with, and
 * the base64url that follows it. `ADMIN_TOKEN_PREFIX` holds no character a
 * regular expression reads as syntax, so it is spliced in as it stands.
 */
const ADMIN_TOKEN_PATTERN = new RegExp(`${ADMIN_TOKEN_PREFIX}[A-Za-z0-9_-]+`, 'g')

/**
 * `setup`'s transcript with any minted token taken out of it, on BOTH streams.
 *
 * The token reaches the wizard through this transcript, and the wizard shows
 * it in exactly ONE place: the final screen, behind a confirmation. Left in
 * the panel it would also sit under the ladder for as long as both services
 * take to answer — on any terminal tall enough to draw that far down the
 * transcript — which is the window the final screen's question exists to
 * close.
 *
 * The mask is a SHAPE, not the token `mintedAdminOf` managed to read: a
 * transcript is masked because it holds something shaped like a token, not
 * because the two lines that name one happened to be there. A run whose
 * `admin:` line never arrived, a token `setup` wrote to stderr and a run that
 * failed after minting one all reach the panel masked; `mintedAdminOf` decides
 * only what the FINAL screen has to show.
 */
function withoutToken(result: RunResult): RunResult {
  return {
    ...result,
    stdout: result.stdout.replace(ADMIN_TOKEN_PATTERN, DEPLOY_TOKEN_PLACEHOLDER),
    stderr: result.stderr.replace(ADMIN_TOKEN_PATTERN, DEPLOY_TOKEN_PLACEHOLDER),
  }
}

/**
 * `setup` finished. A non-zero exit stops the ladder — there is no install to
 * start services for — and the transcript opens at its END, where the check
 * that failed is. A zero exit reads the first admin out of the transcript and
 * either skips both starts (the services belong to Compose or systemd) or asks
 * for the first of them.
 */
function afterSetup(
  model: Model,
  screen: WizardScreen,
  stage: DeployingStage,
  result: RunResult,
): Step {
  const admin = mintedAdminOf(result.stdout)
  const output = outputPanelOf(withoutToken(result))
  if (result.exitCode !== 0) {
    const steps = markStep(stage.steps, 'setup', 'failed', deployExitDetail(result.exitCode))
    const failed = scrollToEnd(output, pageRowsOf(model.size))
    return withScreen(model, { ...screen, stage: { kind: 'setup-failed', steps, output: failed } })
  }

  const detail =
    admin === undefined ? DEPLOY_SETUP_DONE_DETAIL : DEPLOY_SETUP_DONE_WITH_OWNER_DETAIL
  const steps = markStep(stage.steps, 'setup', 'done', detail)
  const values = valuesOf(screen.form)
  if (isExternalSupervisor(values)) {
    return withScreen(model, { ...screen, stage: doneStage(skippedStarts(steps), admin) })
  }

  return advance(model, screen, { steps, next: 'start-ui', output, admin, values })
}

/**
 * A service either answered or did not. A failed start does NOT stop the next
 * one: the console needs no service to sign in with, and an operator who lost
 * one of them is better off with the other running and a line saying so.
 */
function afterStart(
  model: Model,
  screen: WizardScreen,
  stage: DeployingStage,
  step: Exclude<DeployStepId, 'setup'>,
  result: RunResult,
): Step {
  const state: DeployStepState = result.exitCode === 0 ? 'done' : 'failed'
  const steps = markStep(stage.steps, step, state, startDetail(result))
  if (step === 'start-serve') {
    return withScreen(model, { ...screen, stage: doneStage(steps, stage.admin) })
  }

  const values = valuesOf(screen.form)
  const output = outputPanelOf(result)
  return advance(model, screen, { steps, next: 'start-serve', output, admin: stage.admin, values })
}

/** What one rung says: the first thing the command answered, or its exit code. */
function startDetail(result: RunResult): string {
  const line = firstLineOf(result.stdout) ?? firstLineOf(result.stderr)

  // The text comes from a child process, and this line is drawn outside the
  // output panel, which is where the other sanitising happens.
  return line === undefined ? deployExitDetail(result.exitCode) : sanitizeLine(line)
}

function firstLineOf(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '')
}

/** Everything the next rung needs, so `advance` stays one parameter list wide. */
interface Advance {
  readonly steps: readonly DeployStep[]
  readonly next: Exclude<DeployStepId, 'setup'>
  readonly output: OutputPanel
  readonly admin: MintedAdmin | undefined
  readonly values: FormValues
}

/**
 * Opens the next rung: marks it running, shows the transcript of the one that
 * just finished, and asks for the command. The manager waits on the service's
 * probe for the whole of `START_READY_TIMEOUT_MS` inside that one command, so
 * the detail has to carry the wait on its own — no frame arrives meanwhile.
 */
function advance(model: Model, screen: WizardScreen, next: Advance): Step {
  const steps = markStep(
    next.steps,
    next.next,
    'running',
    deployWaitingDetail(START_READY_TIMEOUT_MS),
  )
  const stage: WizardStage = {
    kind: 'deploying',
    steps,
    output: next.output,
    ...(next.admin !== undefined ? { admin: next.admin } : {}),
  }

  return withScreen(model, { ...screen, stage }, [
    { kind: 'wizard-run', step: next.next, request: stepRequestOf(next.next, next.values) },
  ])
}

/** The ladder with one rung replaced; every other rung keeps its identity. */
function markStep(
  steps: readonly DeployStep[],
  id: DeployStepId,
  state: DeployStepState,
  detail: string,
): readonly DeployStep[] {
  return steps.map((each) => (each.id === id ? { id, state, detail } : each))
}

/** Both starts, marked as somebody else's business. */
function skippedStarts(steps: readonly DeployStep[]): readonly DeployStep[] {
  return steps.map((each) =>
    each.id === 'setup' ? each : { id: each.id, state: 'skipped', detail: DEPLOY_EXTERNAL_DETAIL },
  )
}

function doneStage(steps: readonly DeployStep[], admin: MintedAdmin | undefined): WizardStage {
  return {
    kind: 'done',
    steps,
    quitAsked: false,
    ...(admin !== undefined ? { admin } : {}),
  }
}
