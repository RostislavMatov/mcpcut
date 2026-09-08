import { CLI_NAME } from '../setup/constants.js'
import { fitWidth, padRight, sanitizeLine, type Style } from './ansi.js'
import { visibleActions } from './catalogue/index.js'
import {
  ACTIVE_MARKER,
  CARET,
  CONSOLE_TITLE,
  exitLine,
  FOOTER_ROWS,
  HELP_LINES,
  INACTIVE_MARKER,
  QUIT_WITH_TOKEN_QUESTION,
  SECRET_MASK_CHAR,
  SIGNIN_TITLE,
  SIGNIN_TOKEN_LABEL,
} from './constants.js'
import type { FieldState, Form } from './form.js'
import type { MainScreen, RunRequest, Screen, SigninScreen, TerminalSize } from './model.js'
import type { OutputPanel } from './output.js'

/**
 * The right-hand pane of the main screen, and the whole of the sign-in screen
 * (mcpcut phase 2, Task 10).
 *
 * Two rules run through every function here. The first is width: a pane is
 * handed the number of columns it owns and returns lines EXACTLY that wide,
 * because the caller concatenates them with the action column and a frame
 * whose lines drift by a character drifts on screen. The second is that a
 * style is applied only AFTER a line has been padded — SGR codes are
 * invisible bytes that would otherwise be counted as width — which is also
 * what lets a test compare a styled frame with a plain one after stripping.
 *
 * The security invariant of the screen lives here too: a `secret` field is
 * drawn as a run of mask characters as long as its value, and its value is
 * never read into a line. The sign-in token therefore cannot reach a frame
 * even by mistake (ADR-0004 — never in a frame).
 */

/** The two arms of `Screen`, named so the renderers can take one each. */

/** What the sign-in screen offers instead of a key footer. */
export const SIGNIN_FOOTER = 'Enter sign in · Esc quit'

/** What the token field says while the store is being asked about it. */
export const SIGNIN_BUSY_TEXT = 'signing in…'

/** Width the label column of a form is padded to, so the values line up. */
const FIELD_LABEL_WIDTH = 8

/** Gap between a field's value and the hint or error beside it. */
const FIELD_NOTE_GAP = '  '

/** How a confirmation states its two answers and which one is the default. */
const CONFIRM_ANSWER_LINE = 'y/N'

/** Prefix of the line naming the command currently in flight. */
const RUNNING_PREFIX = 'running: $ '

/** Rows the output pane keeps for the command line and for the exit line. */
const OUTPUT_COMMAND_ROWS = 1
const OUTPUT_EXIT_ROWS = 1

/** Blank lines, each exactly `width` wide. */
export function blankRows(count: number, width: number): readonly string[] {
  return Array.from({ length: Math.max(0, count) }, () => padRight('', width))
}

/** Cuts to `rows` lines, padding with blanks when there are too few. */
export function fillTo(lines: readonly string[], rows: number, width: number): readonly string[] {
  if (rows <= 0) return []
  if (lines.length >= rows) return lines.slice(0, rows)

  return [...lines, ...blankRows(rows - lines.length, width)]
}

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
      return actionsPane(screen, width, rows)
    case 'form':
      return formPane(screen, pane.actionId, pane.form, width, rows, style)
    case 'confirm':
      return plainPane([...wrapWords(pane.question, width), '', CONFIRM_ANSWER_LINE], width, rows)
    case 'help':
      return plainPane(HELP_LINES, width, rows)
    case 'quit-confirm':
      return quitConfirmPane(screen, width, rows)
  }
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

/**
 * Breaks a question at spaces so its answer is never cut off by the pane:
 * a confirmation that hides its own "[y/N]" behind an ellipsis is worse than
 * none. A single word longer than the pane still falls to `fitWidth`.
 */
export function wrapWords(text: string, width: number): readonly string[] {
  if (width <= 0) return [text]
  const lines: string[] = []
  let current = ''
  for (const word of text.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (candidate.length <= width || current === '') {
      current = candidate
    } else {
      lines.push(current)
      current = word
    }
  }
  return [...lines, current]
}

/** Lines that are only text: fitted, padded and filled out to the pane. */
export function plainPane(lines: readonly string[], width: number, rows: number): readonly string[] {
  return fillTo(
    lines.map((line) => padRight(line, width)),
    rows,
    width,
  )
}

/**
 * What the pane shows between runs: the finished output, or — before anything
 * has been run — the section's own introduction.
 */
function actionsPane(screen: MainScreen, width: number, rows: number): readonly string[] {
  if (screen.output === undefined) {
    return plainPane(screen.sections[screen.sectionIndex]?.intro ?? [], width, rows)
  }

  return outputLines(screen.output, width, rows)
}

/**
 * The output of a finished run. The exit line owns the LAST row of the pane
 * rather than following the text, so scrolling through a long output never
 * scrolls the verdict off the screen.
 */
export function outputLines(output: OutputPanel, width: number, rows: number): readonly string[] {
  if (rows <= 0) return []

  const available = Math.max(0, rows - OUTPUT_COMMAND_ROWS - OUTPUT_EXIT_ROWS)
  const shown = output.lines.slice(output.scroll, output.scroll + available)
  const head = [output.command, ...shown].map((line) => padRight(line, width))

  return [...fillTo(head, rows - OUTPUT_EXIT_ROWS, width), padRight(exitLine(output.exitCode), width)]
}

/** The form of an action: its title, then one row per field. */
function formPane(
  screen: MainScreen,
  actionId: string,
  form: Form,
  width: number,
  rows: number,
  style: Style,
): readonly string[] {
  const title = actionTitleOf(screen, actionId)

  return fillTo(
    [padRight(title, width), ...fieldLines(form, width, rows - 1, style)],
    rows,
    width,
  )
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

/** The title of the action the pane belongs to — by id, the same key the reducer runs it by. */
function actionTitleOf(screen: MainScreen, actionId: string): string {
  const section = screen.sections[screen.sectionIndex]
  if (section === undefined) return ''

  return visibleActions(section, screen.session.role).find((action) => action.id === actionId)?.title ?? ''
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

/**
 * The sign-in screen, whole: the console's name on top, its block of prompts
 * a third of the way down, and the two keys it answers to at the bottom.
 */
export function renderSignIn(
  screen: SigninScreen,
  size: TerminalSize,
  style: Style,
): readonly string[] {
  const { columns, rows } = size
  if (rows <= 0) return []

  const block = centredBlock(signInBlockOf(screen), columns)
  const top = Math.max(SIGNIN_BLOCK_MIN_ROW, Math.floor(rows / SIGNIN_BLOCK_DIVISOR))
  const above = [
    style.bold(padRight(CONSOLE_TITLE, columns)),
    ...blankRows(top - 1, columns),
    ...block,
  ]
  const footerRow = rows - FOOTER_ROWS

  return [...fillTo(above, footerRow, columns), padRight(SIGNIN_FOOTER, columns)]
}

/** Where the prompt block sits: a third down, but never over the title row. */
const SIGNIN_BLOCK_DIVISOR = 3
const SIGNIN_BLOCK_MIN_ROW = 2

function signInBlockOf(screen: SigninScreen): readonly string[] {
  const notice = screen.notice
  return [
    SIGNIN_TITLE,
    `${SIGNIN_TOKEN_LABEL}: ${screen.busy ? SIGNIN_BUSY_TEXT : maskedTokenOf(screen.form)}`,
    '',
    ...(notice === undefined ? [] : [notice]),
  ]
}

/** The typed token, as long as it is and nothing more: the value never leaves the form. */
function maskedTokenOf(form: Form): string {
  return `${SECRET_MASK_CHAR.repeat(form.fields[0]?.value.length ?? 0)}${CARET}`
}

/** Indents every line of a block by the same amount, so the block stays a block. */
function centredBlock(lines: readonly string[], columns: number): readonly string[] {
  const blockWidth = Math.max(...lines.map((line) => line.length), 0)
  const indent = ' '.repeat(Math.max(0, Math.floor((columns - blockWidth) / 2)))

  return lines.map((line) => padRight(`${indent}${line}`, columns))
}
