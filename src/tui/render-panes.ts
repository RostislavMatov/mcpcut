import { CLI_NAME } from '../setup/constants.js'
import { fitWidth, padRight, sanitizeLine, type Style } from './ansi.js'
import { visibleActions } from './catalogue/index.js'
import type { ActionSpec } from './catalogue/types.js'
import {
  ACTIVE_MARKER,
  CARET,
  FIELD_LABEL_MAX_WIDTH,
  INACTIVE_MARKER,
  QUIT_WITH_TOKEN_QUESTION,
  SECRET_MASK_CHAR,
} from './constants.js'
import {
  TOKEN_HOLD_BANNER,
  TOKEN_HOLD_BANNER_MAX_LINES,
  TOKEN_HOLD_BANNER_SHORT,
} from './constants-live.js'
import type { FieldState, Form } from './form.js'
import { fillTo, wrapWords } from './layout.js'

/** Moved to the layout leaf in phase 6; re-exported so its callers here need not move with it. */
export { wrapWords } from './layout.js'
import type { MainScreen, RunRequest } from './model.js'
import { helpLines } from './render-help.js'
import { outputLines } from './render-output.js'

/**
 * The right-hand pane of the main screen (mcpcut phase 2, Task 10). The
 * sign-in screen it used to draw as well lives in `render-signin.ts` since
 * phase 5 gave that screen a services banner of its own.
 *
 * Two rules run through every function here. The first is width: a pane is
 * handed the number of columns it owns and returns lines EXACTLY that wide,
 * because the caller concatenates them with the action column and a frame
 * whose lines drift by a character drifts on screen. The second is that a
 * style is applied only AFTER a line has been padded — SGR codes are
 * invisible bytes that would otherwise be counted as width — which is also
 * what lets a test compare a styled frame with a plain one after stripping.
 *
 * The security invariant of the screen holds here too: a `secret` field is
 * drawn as a run of mask characters as long as its value, and its value is
 * never read into a line — a typed secret cannot reach a frame even by
 * mistake (ADR-0004 — never in a frame).
 */

/** Width the label column of a form is padded to, so the values line up. */
const FIELD_LABEL_WIDTH = 8

/** Gap between a field's value and the hint or error beside it. */
const FIELD_NOTE_GAP = '  '

/** How a confirmation states its two answers and which one is the default. */
const CONFIRM_ANSWER_LINE = 'y/N'

/** Prefix of the line naming the command currently in flight. */
const RUNNING_PREFIX = 'running: $ '

/**
 * The right-hand pane: the run in flight on top, then whatever the pane kind
 * shows. The running line is prepended here rather than inside each pane so
 * that every pane's row budget already excludes it.
 */
export function paneLines(
  screen: MainScreen,
  width: number,
  rows: number,
  style: Style,
): readonly string[] {
  if (rows <= 0) return []

  const running = screen.busy === undefined ? [] : [padRight(runningLine(screen.busy), width)]
  const body = paneBody(screen, width, rows - running.length, style)

  return [...running, ...body]
}

/** The line naming the command in flight, as both the main screen and the wizard say it. */
export function runningLine(request: RunRequest): string {
  return `${RUNNING_PREFIX}${CLI_NAME} ${request.display.join(' ')}`
}

function paneBody(
  screen: MainScreen,
  width: number,
  rows: number,
  style: Style,
): readonly string[] {
  const { pane } = screen
  switch (pane.kind) {
    case 'actions':
      return actionsPane(screen, width, rows, style)
    case 'form':
      return formPane(screen, pane.actionId, pane.form, width, rows, style)
    case 'confirm':
      return plainPane([...wrapWords(pane.question, width), '', CONFIRM_ANSWER_LINE], width, rows)
    case 'help':
      // Since phase 6 (F3) `render-main.ts` draws `help` as a full-width
      // overlay before it ever asks for a pane, so this arm is not reached
      // from there. It stays so the switch is exhaustive over `Pane`, and it
      // draws the same lines as the overlay so the two can never disagree.
      return fillTo(helpLines(width, rows), rows, width)
    case 'quit-confirm':
      return quitConfirmPane(screen, width, rows)
    case 'token-hold':
      return tokenHoldPane(screen, width, rows, style)
  }
}

/**
 * Which token banner a pane this wide gets (F4, Q29): the long one while it
 * wraps to no more than `TOKEN_HOLD_BANNER_MAX_LINES`, the short one beyond.
 * The rule is the fact of wrapping, not a column threshold, so the 54-column
 * pane of an 80-column terminal and the full 40 of a stacked one are judged
 * the same way — each gets two lines of banner and keeps the token on screen.
 */
export function bannerFor(width: number): string {
  return wrapWords(TOKEN_HOLD_BANNER, width).length > TOKEN_HOLD_BANNER_MAX_LINES
    ? TOKEN_HOLD_BANNER_SHORT
    : TOKEN_HOLD_BANNER
}

/**
 * The banner sits above the output it warns about, inversed AFTER padding, so
 * the token stays on screen while the operator copies it.
 */
function tokenHoldPane(
  screen: MainScreen,
  width: number,
  rows: number,
  style: Style,
): readonly string[] {
  const banner = wrapWords(bannerFor(width), width).map((line) =>
    style.inverse(padRight(line, width)),
  )
  const head = [...banner, padRight('', width)]
  const below =
    screen.output === undefined ? [] : outputLines(screen.output, width, rows - head.length)
  return fillTo([...head, ...below], rows, width)
}

/**
 * The question sits above the output it is about, so the one-time token the
 * operator is being told to save stays on screen while they decide.
 */
function quitConfirmPane(screen: MainScreen, width: number, rows: number): readonly string[] {
  const question = [...wrapWords(QUIT_WITH_TOKEN_QUESTION, width), ''].map((line) => padRight(line, width))
  const below = screen.output === undefined ? [] : outputLines(screen.output, width, rows - question.length)
  return fillTo([...question, ...below], rows, width)
}

/** Lines that are only text: fitted, padded and filled out to the pane. */
export function plainPane(lines: readonly string[], width: number, rows: number): readonly string[] {
  return fillTo(
    lines.map((line) => padRight(line, width)),
    rows,
    width,
  )
}

/** Rows the hint of an action takes under a section intro: a blank one, then itself. */
const HINT_ROWS = 2

/**
 * What the pane shows between runs: the finished output, or — before anything
 * has been run — the section's introduction, closed by the hint of whichever
 * action the cursor is resting on (owner tail Q19).
 *
 * The two hint rows are reserved BEFORE the intro is cut, the way the wizard
 * reserves its token band: a section whose intro fills the pane would
 * otherwise push the hint off the bottom exactly when the pane is busiest.
 */
function actionsPane(
  screen: MainScreen,
  width: number,
  rows: number,
  style: Style,
): readonly string[] {
  const { output } = screen
  if (output !== undefined) return outputLines(output, width, rows)

  const intro = screen.sections[screen.sectionIndex]?.intro ?? []
  const hint = actionUnderCursor(screen)?.hint
  if (hint === undefined) return plainPane(intro, width, rows)

  const head = intro.slice(0, Math.max(0, rows - HINT_ROWS)).map((line) => padRight(line, width))

  return fillTo([...head, padRight('', width), style.dim(padRight(hint, width))], rows, width)
}

/** The action the action column is pointing at, if the cursor is on a real one. */
function actionUnderCursor(screen: MainScreen): ActionSpec | undefined {
  const section = screen.sections[screen.sectionIndex]
  if (section === undefined) return undefined

  return visibleActions(section, screen.session.role)[screen.actionIndex]
}

/**
 * The form of an action: its title, the action's hint under it when it has
 * one (owner tail Q19), then one row per field.
 */
function formPane(
  screen: MainScreen,
  actionId: string,
  form: Form,
  width: number,
  rows: number,
  style: Style,
): readonly string[] {
  const action = actionOf(screen, actionId)
  const hint = action?.hint
  const head = [
    padRight(action?.title ?? '', width),
    ...(hint === undefined ? [] : [style.dim(padRight(hint, width))]),
  ]

  return fillTo(
    [...head, ...fieldLines(form, width, rows - head.length, style, labelWidthOf(form))],
    rows,
    width,
  )
}

/**
 * How wide the label column of a form is: as wide as its longest label, never
 * narrower than the phase-2 default (so short forms keep the look they had)
 * and never wider than `FIELD_LABEL_MAX_WIDTH` — one long label must not push
 * every value off a narrow terminal.
 */
function labelWidthOf(form: Form): number {
  const longest = Math.max(FIELD_LABEL_WIDTH, ...form.fields.map((field) => field.spec.label.length))

  return Math.min(FIELD_LABEL_MAX_WIDTH, longest)
}

/**
 * The rows of a form, scrolled so the focused field is one of them.
 *
 * `labelWidth` is a parameter rather than the constant because the wizard's
 * labels are longer than the catalogue's (`TLS in front`), and a label column
 * sized for one surface would push the other's widgets out of line.
 */
export function fieldLines(
  form: Form,
  width: number,
  rows: number,
  style: Style,
  labelWidth: number = FIELD_LABEL_WIDTH,
): readonly string[] {
  if (rows <= 0) return []

  const first = firstVisibleIndex(form.focus, form.fields.length, rows)

  return form.fields
    .slice(first, first + rows)
    .map((field, index) => fieldLine(field, first + index === form.focus, width, style, labelWidth))
}

/** The action the pane belongs to — by id, the same key the reducer runs it by. */
function actionOf(screen: MainScreen, actionId: string): ActionSpec | undefined {
  const section = screen.sections[screen.sectionIndex]
  if (section === undefined) return undefined

  return visibleActions(section, screen.session.role).find((action) => action.id === actionId)
}

/**
 * Where a scrolling list starts so that `cursor` is on screen: as late as it
 * has to be, never past the point where the last item fills the last row.
 */
export function firstVisibleIndex(cursor: number, length: number, rows: number): number {
  if (rows <= 0) return 0
  return Math.max(0, Math.min(cursor - rows + 1, length - rows))
}

/**
 * One field: marker, label, the widget of its kind, and the note beside it.
 *
 * The note is padded to the end of the line BEFORE it is dimmed, so the whole
 * styled line is still exactly `width` characters of visible text — the
 * trailing spaces it dims are invisible either way.
 */
function fieldLine(
  field: FieldState,
  focused: boolean,
  width: number,
  style: Style,
  labelWidth: number,
): string {
  const marker = focused ? ACTIVE_MARKER : INACTIVE_MARKER
  const label = field.spec.label.padEnd(labelWidth)
  // The one line not built by `padRight` (the note is styled separately), so it sanitises itself.
  const head = fitWidth(sanitizeLine(`${marker}${label} ${widgetOf(field)}${FIELD_NOTE_GAP}`), width)
  const note = padRight(field.error ?? field.spec.hint ?? '', width - head.length)

  return note === '' ? head : `${head}${style.dim(note)}`
}

/** How a field's value is drawn — a secret always as a mask, never as itself. */
function widgetOf(field: FieldState): string {
  switch (field.spec.kind) {
    case 'text':
      return `[${field.value}${CARET}]`
    case 'secret':
      return `[${SECRET_MASK_CHAR.repeat(field.value.length)}${CARET}]`
    case 'choice':
      return `‹ ${field.value} ›`
    case 'flag':
      return field.value === 'true' ? '[x]' : '[ ]'
  }
}
