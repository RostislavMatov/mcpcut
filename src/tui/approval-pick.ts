import { approvalIdOfListLine } from '../cli/approvals-list-format.js'
import { APPROVE_ACTION_ID, DENY_ACTION_ID } from './catalogue/approvals.js'
import { visibleActions } from './catalogue/index.js'
import type { ActionSpec } from './catalogue/types.js'
import type { MainScreen, Pane } from './model.js'
import { STDERR_SEPARATOR, type OutputPanel } from './output.js'

/**
 * Answering a request from the list (owner decision 2026-10-01): typing a
 * 26-character id into the approve form was the console's worst step, so the
 * rows of `approvals list` on screen become the choice itself.
 *
 * The rows are read back from the panel the operator is looking at, not from
 * a second source: what is highlighted is what gets answered. That is safe
 * because a row is exactly one line that starts with its own id
 * (`approvalIdOfListLine`), and only stdout of a successful run counts — the
 * stderr hints below the separator name an id too and must not become rows.
 *
 * Pure: the keys that move through these rows live in `update-pick.ts`.
 */

/** One request on screen. */
export interface ApprovalRow {
  /** Index into `OutputPanel.lines`. */
  readonly line: number
  readonly approvalId: string
  /** The row after its id — server, tool, agent, waits, args — for the question. */
  readonly summary: string
}

/** The requests the panel lists, top to bottom; none for a failed run or no panel. */
export function approvalRowsOf(panel: OutputPanel | undefined): readonly ApprovalRow[] {
  if (panel === undefined || panel.exitCode !== 0) return []
  const separator = panel.lines.indexOf(STDERR_SEPARATOR)
  const stdout = separator === -1 ? panel.lines : panel.lines.slice(0, separator)

  return stdout.flatMap((text, line) => {
    const approvalId = approvalIdOfListLine(text)
    return approvalId === undefined ? [] : [{ line, approvalId, summary: text.slice(approvalId.length).trim() }]
  })
}

/** The pane that selects `row`. */
export function pickPaneOf(row: ApprovalRow): Pane {
  return { kind: 'pick', approvalId: row.approvalId }
}

/** The panel scrolled just enough that `line` is on screen. */
export function withLineInView(panel: OutputPanel, line: number, pageRows: number): OutputPanel {
  if (line < panel.scroll) return { ...panel, scroll: line }
  if (line >= panel.scroll + pageRows) return { ...panel, scroll: line - pageRows + 1 }

  return panel
}

/** The two actions a picked request is answered with — both or neither: a role that may not resolve is never asked. */
export interface AnswerActions {
  readonly approve: ActionSpec
  readonly deny: ActionSpec
}

export function answerActionsOf(screen: MainScreen): AnswerActions | undefined {
  const section = screen.sections[screen.sectionIndex]
  if (section === undefined) return undefined
  const actions = visibleActions(section, screen.session.role)
  const approve = actions.find((action) => action.id === APPROVE_ACTION_ID)
  const deny = actions.find((action) => action.id === DENY_ACTION_ID)

  return approve === undefined || deny === undefined ? undefined : { approve, deny }
}
