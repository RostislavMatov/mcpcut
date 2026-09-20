import { padRight, sanitizeLine, type Style } from './ansi.js'
import { ACTIVE_MARKER, CARET, CONSOLE_TITLE, FOOTER_ROWS, INACTIVE_MARKER, SECRET_MASK_CHAR } from './constants.js'
import {
  WELCOME_CHOOSE_FOOTER,
  WELCOME_CONNECT_BUSY_TEXT,
  WELCOME_CONNECT_FOOTER,
  WELCOME_CONNECT_TITLE,
  WELCOME_OPTION_CONNECT,
  WELCOME_OPTION_INSTALL,
  WELCOME_TITLE,
} from './constants-live.js'
import type { FieldState, Form } from './form.js'
import { blankRows, fillTo } from './layout.js'
import type { TerminalSize, WelcomeScreen, WelcomeStage } from './model.js'
import { wrapWords } from './render-panes.js'

/**
 * The welcome screen, whole (2026-09-19): the same centred-block shape as the
 * sign-in and first-owner screens it stands beside — the console's name on
 * top, a block a third of the way down, and one line of keys at the bottom —
 * so it draws correctly at the smallest supported terminal and under
 * `NO_COLOR`/`TERM=dumb` for free, exactly as those two already do.
 *
 * Every string typed or read from a command is sanitised before it is
 * measured or padded, the same discipline `render-first-owner.ts` follows.
 */

const BLOCK_DIVISOR = 3
const BLOCK_MIN_ROW = 2
/** The block never uses the full width: a wrapped notice reads better narrow. */
const BLOCK_MAX_WIDTH = 72

const WELCOME_OPTIONS: readonly string[] = [WELCOME_OPTION_INSTALL, WELCOME_OPTION_CONNECT]

export function renderWelcome(screen: WelcomeScreen, size: TerminalSize, style: Style): readonly string[] {
  const { columns, rows } = size
  if (rows <= 0) return []

  const width = Math.min(columns, BLOCK_MAX_WIDTH)
  const indent = ' '.repeat(Math.max(0, Math.floor((columns - width) / 2)))
  const block = blockOf(screen.stage, width).map((line) => padRight(`${indent}${line}`, columns))
  const top = Math.max(BLOCK_MIN_ROW, Math.floor(rows / BLOCK_DIVISOR))
  const above = [style.bold(padRight(CONSOLE_TITLE, columns)), ...blankRows(top - 1, columns), ...block]
  const footer = screen.stage.kind === 'choose' ? WELCOME_CHOOSE_FOOTER : WELCOME_CONNECT_FOOTER

  return [...fillTo(above, rows - FOOTER_ROWS, columns), padRight(footer, columns)]
}

function blockOf(stage: WelcomeStage, width: number): readonly string[] {
  if (stage.kind === 'choose') return chooseLines(stage.index)
  if (stage.busy) return [WELCOME_CONNECT_TITLE, '', WELCOME_CONNECT_BUSY_TEXT]

  return [
    WELCOME_CONNECT_TITLE,
    '',
    ...fieldLines(stage.form),
    ...(stage.notice === undefined ? [] : ['', ...wrapWords(sanitizeLine(stage.notice), width)]),
  ]
}

function chooseLines(index: number): readonly string[] {
  return [WELCOME_TITLE, '', ...WELCOME_OPTIONS.map((option, position) => optionLine(option, position === index))]
}

function optionLine(option: string, active: boolean): string {
  return `${active ? ACTIVE_MARKER : INACTIVE_MARKER}${option}`
}

/** One line per field of the connect form, with the caret on the focused one and its error under it. */
function fieldLines(form: Form): readonly string[] {
  return form.fields.flatMap((field, index) => [
    `${field.spec.label}: ${valueTextOf(field)}${index === form.focus ? CARET : ''}`,
    ...(field.error === undefined ? [] : [`  ${sanitizeLine(field.error)}`]),
  ])
}

/** A `secret` field is drawn as a run of masks; none of this form's fields are one today. */
function valueTextOf(field: FieldState): string {
  return field.spec.kind === 'secret' ? SECRET_MASK_CHAR.repeat(field.value.length) : sanitizeLine(field.value)
}
