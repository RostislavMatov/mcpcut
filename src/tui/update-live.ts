import { refreshActionOf } from './catalogue/index.js'
import { paneWidthOf } from './layout.js'
import type { Model, Msg, Step } from './model.js'
import { outputPanelOf, replacedOutput, type RunResult } from './output.js'
import { subscriptionOf } from './subscriptions.js'
import { requestOf } from './update-form.js'
import { type MainScreen, noEffects, pageRowsOf, withMain } from './update-step.js'

/**
 * The messages that arrive without a key (mcpcut phase 5, Task 5): the console
 * opened, the timer ticked, a quiet poll answered.
 *
 * Split from `update-main.ts` because none of the three is a keystroke and all
 * three share one rule — they may only change a screen the operator is not
 * using. The tick asks `subscriptionOf`, which is the SAME question the runtime
 * asked before arming the timer, so a tick that arrives after the screen moved
 * on is dropped by the rule that would have stopped the timer. The poll's
 * answer is checked again on arrival, because between the ask and the answer
 * the operator may have opened a form, started a run or been shown a token.
 */

/** Folds a message nobody typed into the main screen. */
export function updateLive(model: Model, screen: MainScreen, msg: Msg): Step {
  if (msg.kind === 'tick') return onTick(model, screen)
  if (msg.kind === 'poll-result') return onPollResult(model, screen, msg.result)

  // `opened` on the main screen: the header was filled by the sign-in that
  // built this screen, and nothing else here is asked for at startup.
  return noEffects(model)
}

/**
 * The timer fired. `subscriptionOf` decides whether anything is due at all — a
 * run in flight, a poll already out, an open pane, a token on hold or a tab
 * that does not re-read itself all mean the tick is dropped.
 */
function onTick(model: Model, screen: MainScreen): Step {
  if (subscriptionOf(model) === undefined) return noEffects(model)

  const action = refreshActionOf(screen.sections, screen.session.role, screen.sectionIndex)
  const polling = sectionIdOf(screen)
  if (action === undefined || polling === undefined) return noEffects(model)

  // `polling` rather than `busy`: no running line, no deaf keyboard. It names
  // the section the poll is FOR, so the answer can tell whether the operator
  // is still there. It is dropped by that answer, which is what makes the
  // interval count from the ANSWER and not from the tick (plan P1).
  return withMain(model, screen, { polling }, [
    { kind: 'poll', request: requestOf(action, {}) },
  ])
}

/** Id of the tab the cursor is on, or `undefined` for an index outside the list. */
function sectionIdOf(screen: MainScreen): string | undefined {
  return screen.sections[screen.sectionIndex]?.id
}

/**
 * The quiet poll answered. It re-arms the timer either way (`polling` goes),
 * and only redraws a pane the operator is still looking at.
 *
 * Four things can have happened between the ask and the answer, and three of
 * them mean the output is dropped: a pane was opened over the list, a run was
 * started, or the operator left the tab the poll was for. The last one is why
 * `polling` names a section: `approvals list` answering under the Journal tab
 * would put another tab's command line and text on a screen nobody asked it
 * of.
 */
function onPollResult(model: Model, screen: MainScreen, result: RunResult): Step {
  const stale = screen.polling !== sectionIdOf(screen)
  if (stale || screen.pane.kind !== 'actions' || screen.busy !== undefined) {
    return withMain(model, screen, { polling: undefined })
  }

  const output = replacedOutput(
    screen.output,
    outputPanelOf(result),
    pageRowsOf(model.size),
    paneWidthOf(model.size.columns),
  )

  return withMain(model, screen, { polling: undefined, output })
}
