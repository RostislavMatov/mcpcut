import { padRight, type Style } from './ansi.js'
import { approvalRowsOf } from './approval-pick.js'
import { fillTo, wrapWords } from './layout.js'
import type { MainScreen, Pane } from './model.js'
import { outputLines } from './render-output.js'

/**
 * The two panes of answering a request from the list (owner decision
 * 2026-10-01; keys in `update-pick.ts`): the list with the picked row marked,
 * and the question about it with its three answers.
 */

/** The question's first line, and its three answers in the owner's words: yes, no, close. */
export const ANSWER_QUESTION = 'Answer this request?'
export const ANSWER_LINES: readonly string[] = [
  'y    yes — approve the call',
  'n    no — deny it; the agent gets a refusal',
  'Esc  close — the request keeps waiting',
]

/**
 * Most lines of the request's row the question repeats: enough for a whole
 * row (its args are capped at 120 characters) on a 54-column pane.
 */
const SUMMARY_MAX_LINES = 6

/** Rows the question takes besides the summary: its line, the id, a blank, the answers. */
const ANSWER_FIXED_ROWS = 3 + ANSWER_LINES.length

type PickPane = Extract<Pane, { kind: 'pick' }>
type AnswerPane = Extract<Pane, { kind: 'answer' }>

export function pickPaneLines(
  screen: MainScreen,
  pane: PickPane,
  width: number,
  rows: number,
  style: Style,
): readonly string[] {
  if (screen.output === undefined) return fillTo([], rows, width)
  const row = approvalRowsOf(screen.output).find((each) => each.approvalId === pane.approvalId)

  return row === undefined
    ? outputLines(screen.output, width, rows)
    : outputLines(screen.output, width, rows, { line: row.line, style })
}

export function answerPaneLines(pane: AnswerPane, width: number, rows: number): readonly string[] {
  const summaryRows = Math.max(0, Math.min(SUMMARY_MAX_LINES, rows - ANSWER_FIXED_ROWS))
  const lines = [
    ANSWER_QUESTION,
    pane.approvalId,
    ...wrapHard(pane.summary, width).slice(0, summaryRows),
    '',
    ...ANSWER_LINES.flatMap((line) => wrapWords(line, width)),
  ]

  return fillTo(
    lines.map((line) => padRight(line, width)),
    rows,
    width,
  )
}

/** `wrapWords`, and a word wider than the pane (the args JSON) cut into pane-wide pieces rather than lost to the ellipsis. */
function wrapHard(text: string, width: number): readonly string[] {
  if (width <= 0) return [text]

  return wrapWords(text, width).flatMap((line) =>
    Array.from({ length: Math.max(1, Math.ceil(line.length / width)) }, (_, index) =>
      line.slice(index * width, (index + 1) * width),
    ),
  )
}
