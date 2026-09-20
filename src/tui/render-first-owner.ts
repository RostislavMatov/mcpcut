import { padRight, sanitizeLine, type Style } from './ansi.js'
import { CARET, CONSOLE_TITLE, FOOTER_ROWS, SECRET_MASK_CHAR, WIZARD_TOKEN_FOOTER } from './constants.js'
import {
  FIRST_OWNER_BUSY_TEXT,
  FIRST_OWNER_FOOTER,
  FIRST_OWNER_HINT,
  FIRST_OWNER_TITLE,
  FIRST_OWNER_TOKEN_QUESTION,
  REMOTE_ADDRESS_PREFIX,
  REMOTE_INSECURE_NOTICE,
} from './constants-live.js'
import type { FieldState, Form } from './form.js'
import { blankRows, fillTo } from './layout.js'
import type { FirstOwnerScreen, FirstOwnerStage, InstallFacts, TerminalSize } from './model.js'
import { wrapWords } from './render-panes.js'
import { tokenLines } from './render-wizard.js'

/**
 * The first-owner screen, whole (2026-09-19; the remote form of ADR-0014
 * added a second field): the console's name on top, the block a third of the
 * way down like the sign-in screen it stands in for, and the keys it answers
 * to at the bottom.
 *
 * The token band is the wizard's own (`tokenLines`): one shape for a one-time
 * token across the console, so the label/token wrapping at 80 columns and the
 * quit question are not re-derived here. Everything typed or read from a
 * command is sanitised before it is measured or padded, and a `secret` field
 * is drawn as a run of mask characters and never as itself — the remote
 * form's setup code included (ADR-0004's rule, extended: never in a frame).
 */

const BLOCK_DIVISOR = 3
const BLOCK_MIN_ROW = 2
/** The block never uses the full width: a wrapped hint reads better narrow. */
const BLOCK_MAX_WIDTH = 72

export function renderFirstOwner(
  screen: FirstOwnerScreen,
  size: TerminalSize,
  style: Style,
  install?: InstallFacts,
): readonly string[] {
  const { columns, rows } = size
  if (rows <= 0) return []

  const width = Math.min(columns, BLOCK_MAX_WIDTH)
  const indent = ' '.repeat(Math.max(0, Math.floor((columns - width) / 2)))
  const block = blockOf(screen.stage, width, install).map((line) => padRight(`${indent}${line}`, columns))
  const top = Math.max(BLOCK_MIN_ROW, Math.floor(rows / BLOCK_DIVISOR))
  const above = [style.bold(padRight(CONSOLE_TITLE, columns)), ...blankRows(top - 1, columns), ...block]
  const footer = footerOf(screen.stage, install)

  return [...fillTo(above, rows - FOOTER_ROWS, columns), padRight(footer, columns)]
}

/**
 * `hold` keeps its own footer (the token question answers `y`/`q`, not
 * Ctrl-D). The FORM stage adds "Ctrl-D disconnect" only on a remote console
 * (2026-09-20) — the token-hold stage never advertises the chord at all,
 * since it never answers to it (`update-first-owner.ts`'s own routing keeps
 * Ctrl-D out of that stage regardless of what a footer said).
 */
function footerOf(stage: FirstOwnerStage, install: InstallFacts | undefined): string {
  if (stage.kind === 'hold') return WIZARD_TOKEN_FOOTER

  return install?.remote === true ? `${FIRST_OWNER_FOOTER} · Ctrl-D disconnect` : FIRST_OWNER_FOOTER
}

function blockOf(stage: FirstOwnerStage, width: number, install: InstallFacts | undefined): readonly string[] {
  const address = remoteAddressLines(install)
  if (stage.kind === 'hold') {
    return [
      FIRST_OWNER_TITLE,
      ...address,
      '',
      ...tokenLines(stage.admin, stage.quitAsked, width, FIRST_OWNER_TOKEN_QUESTION),
      ...(stage.warning === undefined ? [] : ['', ...wrapWords(stage.warning, width)]),
    ]
  }

  if (stage.busy) {
    return [FIRST_OWNER_TITLE, ...address, FIRST_OWNER_BUSY_TEXT, '', ...wrapWords(FIRST_OWNER_HINT, width)]
  }

  return [
    FIRST_OWNER_TITLE,
    ...address,
    ...fieldLines(stage.form),
    ...(stage.notice === undefined ? [] : ['', sanitizeLine(stage.notice)]),
    '',
    ...wrapWords(FIRST_OWNER_HINT, width),
  ]
}

/** The same remote-address lines the sign-in screen shows (`render-signin.ts`). */
function remoteAddressLines(install: InstallFacts | undefined): readonly string[] {
  const address = install?.remoteAddress
  if (address === undefined) return []

  return [
    `${REMOTE_ADDRESS_PREFIX}${sanitizeLine(address)}`,
    ...(install?.remoteInsecure === true ? [REMOTE_INSECURE_NOTICE] : []),
  ]
}

/**
 * One line per field of the form — the remote form's two (`code`, `name`) or
 * the local one's single `name` — with the caret on whichever the operator
 * is typing into, and any field's own error under it.
 */
function fieldLines(form: Form): readonly string[] {
  return form.fields.flatMap((field, index) => [
    `${field.spec.label}: ${valueTextOf(field)}${index === form.focus ? CARET : ''}`,
    ...(field.error === undefined ? [] : [`  ${sanitizeLine(field.error)}`]),
  ])
}

/** A `secret` field is drawn as a run of masks, exactly as long as what was typed and nothing else. */
function valueTextOf(field: FieldState): string {
  return field.spec.kind === 'secret'
    ? SECRET_MASK_CHAR.repeat(field.value.length)
    : sanitizeLine(field.value)
}
