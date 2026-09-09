import { EXTERNAL_SUPERVISOR } from '../services/constants.js'
import { padRight, sanitizeLine, type Style } from './ansi.js'
import {
  CARET,
  CONSOLE_TITLE,
  FOOTER_ROWS,
  SECRET_MASK_CHAR,
  SIGNIN_TITLE,
  SIGNIN_TOKEN_LABEL,
} from './constants.js'
import {
  SIGNIN_SERVICES_DOWN_HINT,
  SIGNIN_SERVICES_EXTERNAL_HINT,
  SIGNIN_SERVICES_PREFIX,
} from './constants-live.js'
import type { Form } from './form.js'
import { blankRows, fillTo } from './layout.js'
import type { InstallFacts, SigninScreen, TerminalSize } from './model.js'
import { hasDownService, servicesHeaderPart, type ServiceSummary } from './services-summary.js'

/**
 * The sign-in screen, whole (mcpcut phase 2, Task 10; the services banner is
 * phase 5, plan P3).
 *
 * Split out of `render-panes.ts` when the banner arrived: that file draws the
 * right-hand pane of the MAIN screen and had been hosting this screen only
 * because both are made of padded lines, and neither had room for the other
 * once both grew.
 *
 * The two rules of the renderer hold here as everywhere: a line is padded to
 * the terminal's columns BEFORE a style touches it — SGR bytes are invisible
 * and would otherwise be counted as width — and the token that was typed is
 * drawn as a run of mask characters and never as itself, so the sign-in
 * secret cannot reach a frame even by mistake (ADR-0004 — never in a frame).
 */

/** What the sign-in screen offers instead of a key footer. */
export const SIGNIN_FOOTER = 'Enter sign in · Esc quit'

/** What the token field says while the store is being asked about it. */
export const SIGNIN_BUSY_TEXT = 'signing in…'

/**
 * The sign-in screen, whole: the console's name on top, its block of prompts
 * a third of the way down, and the two keys it answers to at the bottom.
 */
export function renderSignIn(
  screen: SigninScreen,
  size: TerminalSize,
  style: Style,
  install?: InstallFacts,
): readonly string[] {
  const { columns, rows } = size
  if (rows <= 0) return []

  const block = centredBlock(signInBlockOf(screen, install), columns)
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

/**
 * The notice is sanitised HERE rather than left to `padRight`, because the
 * block below is centred on the length of its longest line: an unreadable
 * store leaves a raw `error.message` as the notice, and bytes that will never
 * be drawn would still be counted, sliding the whole block left. The services
 * line answers for itself the same way (`servicesHeaderPart`).
 */
function signInBlockOf(screen: SigninScreen, install: InstallFacts | undefined): readonly string[] {
  const notice = screen.notice
  return [
    SIGNIN_TITLE,
    `${SIGNIN_TOKEN_LABEL}: ${screen.busy ? SIGNIN_BUSY_TEXT : maskedTokenOf(screen.form)}`,
    '',
    ...(notice === undefined ? [] : [sanitizeLine(notice)]),
    ...servicesBannerLines(screen.services, install),
  ]
}

/**
 * The services line and, when one of them is down, what to do about it;
 * nothing at all until `status` has answered.
 *
 * Silence is the point of the first guard: the console asks about the daemons
 * on its way in, and a line that said `services: —` while the answer was
 * still in flight would tell a whole class of install that everything was
 * down. Under an external supervisor the advice changes rather than
 * disappears — `Services ▸ start` is not offered there at all (Q16).
 */
export function servicesBannerLines(
  statuses: readonly ServiceSummary[] | undefined,
  install: InstallFacts | undefined,
): readonly string[] {
  if (statuses === undefined || statuses.length === 0) return []

  const line = `${SIGNIN_SERVICES_PREFIX}${servicesHeaderPart(statuses)}`
  if (!hasDownService(statuses)) return [line]

  return [
    line,
    install?.supervisor === EXTERNAL_SUPERVISOR
      ? SIGNIN_SERVICES_EXTERNAL_HINT
      : SIGNIN_SERVICES_DOWN_HINT,
  ]
}

/** The typed token, as long as it is and nothing more: the value never leaves the form. */
function maskedTokenOf(form: Form): string {
  return `${SECRET_MASK_CHAR.repeat(form.fields[0]?.value.length ?? 0)}${CARET}`
}

/**
 * Indents every line of a block by the same amount, so the block stays a
 * block. The block is centred on its LONGEST line, so the services banner —
 * wider than the title it sits under — shifts the whole block left rather
 * than being cut to fit beside it.
 */
function centredBlock(lines: readonly string[], columns: number): readonly string[] {
  const blockWidth = Math.max(...lines.map((line) => line.length), 0)
  const indent = ' '.repeat(Math.max(0, Math.floor((columns - blockWidth) / 2)))

  return lines.map((line) => padRight(`${indent}${line}`, columns))
}
