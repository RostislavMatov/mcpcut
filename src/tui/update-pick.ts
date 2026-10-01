import {
  answerActionsOf,
  approvalRowsOf,
  type ApprovalRow,
  pickPaneOf,
  withLineInView,
} from './approval-pick.js'
import type { ActionSpec } from './catalogue/types.js'
import type { KeyEvent } from './keys.js'
import type { Model, Pane, RunRequest, Step } from './model.js'
import type { OutputPanel } from './output.js'
import { effectOf, isYes, requestOf } from './update-form.js'
import { type ApplyKey, verticalStepOf } from './update-keys.js'
import { ACTIONS_PANE, type MainScreen, noEffects, pageRowsOf, withMain } from './update-step.js'

/**
 * The keys of Approvals ▸ list once its rows are open (owner decision
 * 2026-10-01): ↑↓ choose a request, Enter asks about it, and the question
 * has three answers — y approves, n denies, Esc closes it and the request
 * keeps waiting. The answer runs the section's own `approve`/`deny` with the
 * id filled in, so the command line on the pane is the one a shell would run.
 *
 * Two rules keep the answer the operator's own. Nothing redraws under the
 * question (`subscriptionOf` polls the pick pane, never this one), and a key
 * typed ahead while `list` was running never answers it (`replayPending`
 * stops at this pane).
 */

export type PickPane = Extract<Pane, { kind: 'pick' }>
export type AnswerPane = Extract<Pane, { kind: 'answer' }>

/** A pane and the output it is drawn over, chosen together so the selected row is on screen. */
export interface PickView {
  readonly pane: Pane
  readonly output: OutputPanel
}

const DENY_ANSWERS: readonly string[] = ['n', 'N']

/** Enter on a `picksApprovals` action: the same run as ever, marked so that its answer opens the rows. */
export function runToPick(model: Model, screen: MainScreen, action: ActionSpec): Step {
  const request: RunRequest = { ...requestOf(action, {}), picksRows: true }
  return withMain(model, screen, { pane: ACTIONS_PANE, busy: request }, [effectOf(request)])
}

/** After that run: its first request selected — or `undefined` (no rows, or a role that may not answer). */
export function pickAfterRun(model: Model, screen: MainScreen, output: OutputPanel): PickView | undefined {
  if (screen.busy?.picksRows !== true || answerActionsOf(screen) === undefined) return undefined
  const [first] = approvalRowsOf(output)

  return first === undefined ? undefined : viewOf(model, output, first)
}

/**
 * After a quiet poll redrew the list: the same request stays selected; when it
 * is gone (answered elsewhere, expired) its neighbour takes its place, and
 * with no rows left the pane goes back to the actions.
 */
export function pickAfterPoll(model: Model, screen: MainScreen, output: OutputPanel): PickView {
  const { pane } = screen
  if (pane.kind !== 'pick') return { pane, output }
  const rows = approvalRowsOf(output)
  const before = approvalRowsOf(screen.output).findIndex((row) => row.approvalId === pane.approvalId)
  const row = rows.find((each) => each.approvalId === pane.approvalId) ?? rows[clamp(before, rows.length)]

  return row === undefined ? { pane: ACTIONS_PANE, output } : viewOf(model, output, row)
}

export function updatePickPane(
  model: Model,
  screen: MainScreen,
  pane: PickPane,
  key: KeyEvent,
  outside: ApplyKey,
): Step {
  const rows = approvalRowsOf(screen.output)
  const index = rows.findIndex((row) => row.approvalId === pane.approvalId)
  const row = rows[index]
  if (row === undefined || key.kind === 'escape') return withMain(model, screen, { pane: ACTIONS_PANE })
  if (key.kind === 'enter') {
    return withMain(model, screen, { pane: { kind: 'answer', approvalId: row.approvalId, summary: row.summary } })
  }
  const step = verticalStepOf(key)
  if (step === undefined) return outside(model, screen, key)
  const next = rows[clamp(index + step, rows.length)]
  if (next === undefined || next === row || screen.output === undefined) return noEffects(model)

  return withMain(model, screen, viewOf(model, screen.output, next))
}

export function updateAnswerPane(model: Model, screen: MainScreen, pane: AnswerPane, key: KeyEvent): Step {
  if (key.kind === 'escape') return withMain(model, screen, { pane: { kind: 'pick', approvalId: pane.approvalId } })
  const answer = isYes(key) ? 'approve' : isDeny(key) ? 'deny' : undefined
  if (answer === undefined) return noEffects(model)
  const actions = answerActionsOf(screen)
  if (actions === undefined) return withMain(model, screen, { pane: ACTIONS_PANE })
  const request = requestOf(actions[answer], { id: pane.approvalId })

  return withMain(model, screen, { pane: ACTIONS_PANE, busy: request }, [effectOf(request)])
}

function isDeny(key: KeyEvent): boolean {
  return key.kind === 'char' && DENY_ANSWERS.includes(key.char)
}

function viewOf(model: Model, output: OutputPanel, row: ApprovalRow): PickView {
  return { pane: pickPaneOf(row), output: withLineInView(output, row.line, pageRowsOf(model.size)) }
}

/** `index` held inside `0 … length-1`; `-1` (not found) reads as the first row. */
function clamp(index: number, length: number): number {
  return Math.min(Math.max(0, index), length - 1)
}
