import { refreshActionOf } from './catalogue/index.js'
import { WIZARD_STOPWATCH_INTERVAL_MS } from './constants-live.js'
import type { DeployStepId, Model, WizardStage } from './model.js'

/**
 * The console's subscriptions (mcpcut phase 5, Task 4) — Elm's
 * `subscriptions: Model -> Sub`, of which there are two: how long until the
 * next quiet poll of a tab that re-reads itself, and, since phase 6 (F8), the
 * second the wizard counts beside a service it is waiting on.
 *
 * A pure question over the model, and that is the point. The runtime
 * reconciles its SINGLE timer against this answer after every step, and the
 * reducer asks the same question again when a tick arrives, so the two sides
 * agree by construction: a tick that reaches a screen which is no longer
 * polling is dropped by the same rule that would have stopped the timer.
 *
 * A leaf below `runtime.ts` and `update-*.ts`: it reads the catalogue and the
 * model's types, and nothing that folds a message.
 */

/** The rungs whose wait has a limit worth counting against: the two service starts. */
const COUNTED_STEPS: ReadonlySet<DeployStepId> = new Set<DeployStepId>(['start-ui', 'start-serve'])

/**
 * Whether the wizard is waiting on a service to answer: the `deploying` stage
 * with a `start-*` rung running. `setup` is not counted — it answers in the
 * time it takes to write files, and its detail names no limit to count against.
 * Shared with the wizard's tick handler, so the reducer counts exactly when
 * the runtime's timer is armed and never a second longer.
 */
export function isWaitingOnStart(stage: WizardStage): boolean {
  if (stage.kind !== 'deploying') return false

  return stage.steps.some((step) => step.state === 'running' && COUNTED_STEPS.has(step.id))
}

/** How long until the next tick, or `undefined` when nothing on this screen is timed. */
export function subscriptionOf(model: Model): number | undefined {
  const { screen } = model
  if (screen.kind === 'wizard') {
    return isWaitingOnStart(screen.stage) ? WIZARD_STOPWATCH_INTERVAL_MS : undefined
  }
  if (screen.kind !== 'main') return undefined

  // A run in flight owns the pane, and a poll already asked is not asked
  // twice: the interval counts from the ANSWER, so the timer stays down until
  // `poll-result` clears `polling` (plan P1).
  if (screen.busy !== undefined || screen.polling !== undefined) return undefined

  // Any other pane — a form, a confirm, the help, the quit question, a
  // one-time token nobody has saved yet — is something the operator is
  // reading, and a poll that redrew underneath it would take it away.
  if (screen.pane.kind !== 'actions') return undefined

  const delay = screen.sections[screen.sectionIndex]?.autoRefreshMs
  if (delay === undefined) return undefined

  // The tab must also have something to run: a refresh action this role may
  // run and that needs no form. Without it the timer would fire into nothing.
  const action = refreshActionOf(screen.sections, screen.session.role, screen.sectionIndex)
  return action === undefined ? undefined : delay
}
