import { padRight, type Style } from './ansi.js'
import { visibleActions } from './catalogue/index.js'
import {
  ACTIVE_MARKER,
  CONSOLE_TITLE,
  FOOTER_ROWS,
  FORM_HELP_FOOTER,
  HEADER_ROWS,
  HEADER_SEPARATOR,
  INACTIVE_MARKER,
  KEY_HELP_FOOTER,
  RULE_CHAR,
  TAB_OVERFLOW_LEFT,
  TAB_OVERFLOW_RIGHT,
  TAB_SEPARATOR,
} from './constants.js'
import { bodyWidthsOf } from './layout.js'
import type { MainScreen, TerminalSize } from './model.js'
import { isOutputClipped } from './render-output.js'
import { firstVisibleIndex, paneLines } from './render-panes.js'
import { servicesHeaderPart } from './services-summary.js'
import { tabWindowOf } from './tabs.js'

/**
 * The main screen (mcpcut phase 2, Task 10): who is signed in, which section
 * is open, the actions of that section, and the pane beside them.
 *
 * The screen is three bands. The header (`HEADER_ROWS`) never moves: title
 * line, tab bar, rule. The footer (`FOOTER_ROWS`) is one line of key hints,
 * chosen by the pane on screen. Everything between is the body, split into a
 * fixed action column and a pane that takes the rest — and every band returns
 * lines exactly `columns` wide, so the caller can count rows without
 * measuring anything.
 *
 * Widths are clamped rather than assumed: a terminal narrower than the layout
 * gets a pane of zero columns and a clipped action column, because an
 * operator who shrank a window wants their session back, not a refusal.
 */

/**
 * The footer while a run is in flight (owner tail Q22).
 *
 * `update.ts` makes the keyboard deaf until the run answers, so a slow
 * command used to read as a wedged console: the pane said `running: $ …` and
 * every key did nothing, with no line saying why or what still works.
 */
export const RUNNING_HELP_FOOTER =
  'running… · keys are ignored until it finishes · Ctrl-C aborts'

/**
 * The footer while the output pane is cut on either side (owner tail Q24). It
 * buys the room for `[ ] scroll` by dropping `r refresh`, which is the one
 * hint of the normal footer that belongs to the section rather than to the
 * pane the operator is reading.
 */
export const CLIPPED_HELP_FOOTER =
  'Tab sections · ↑↓ actions · Enter run · PgUp/PgDn · [ ] scroll · ? help · q quit'

/** The whole main screen, header to footer. */
export function renderMain(
  screen: MainScreen,
  size: TerminalSize,
  style: Style,
): readonly string[] {
  const { columns, rows } = size
  const bodyRows = Math.max(0, rows - HEADER_ROWS - FOOTER_ROWS)

  return [
    style.bold(padRight(headerText(screen), columns)),
    tabsLine(screen, columns, style),
    RULE_CHAR.repeat(Math.max(0, columns)),
    ...bodyLines(screen, columns, bodyRows, style),
    padRight(footerText(screen, columns, bodyRows), columns),
  ]
}

function headerText(screen: MainScreen): string {
  const { adminName, role } = screen.session

  return [
    CONSOLE_TITLE,
    `${adminName} (${role})`,
    servicesHeaderPart(screen.services),
  ].join(HEADER_SEPARATOR)
}

/**
 * The tab bar: a window over the section labels, since eleven of them are
 * half again as wide as an 80-column terminal (`tabs.ts` decides which fit).
 *
 * The active tab is inversed AFTER the whole line has been padded, and only
 * when the padding did not cut into it: a style applied to an already-
 * truncated span would put its terminator in the wrong place.
 */
function tabsLine(screen: MainScreen, columns: number, style: Style): string {
  const labels = screen.sections.map((section, index) => `${index + 1} ${section.title}`)
  const window = tabWindowOf(labels, screen.sectionIndex, columns)
  const left = window.hiddenBefore ? TAB_OVERFLOW_LEFT : ''
  const right = window.hiddenAfter ? TAB_OVERFLOW_RIGHT : ''
  const plain = `${left}${labels.slice(window.first, window.last + 1).join(TAB_SEPARATOR)}${right}`
  const padded = padRight(plain, columns)

  const active = labels[screen.sectionIndex]
  if (active === undefined || screen.sectionIndex < window.first) return padded

  const start = left.length + labels
    .slice(window.first, screen.sectionIndex)
    .reduce((total, label) => total + label.length + TAB_SEPARATOR.length, 0)
  const end = start + active.length
  const limit = plain.length > columns ? Math.max(0, columns - 1) : padded.length
  if (end > limit) return padded

  return `${padded.slice(0, start)}${style.inverse(padded.slice(start, end))}${padded.slice(end)}`
}

/** The body: the action column and the pane, joined row by row. */
function bodyLines(
  screen: MainScreen,
  columns: number,
  rows: number,
  style: Style,
): readonly string[] {
  if (rows <= 0) return []

  const widths = bodyWidthsOf(columns)
  const actions = actionColumn(screen, widths.action, rows)
  const pane = paneLines(screen, widths.pane, rows, style)
  const gap = ' '.repeat(widths.gap)

  return Array.from(
    { length: rows },
    (_, index) => `${actions[index] ?? padRight('', widths.action)}${gap}${pane[index] ?? padRight('', widths.pane)}`,
  )
}

/** The left column: one row per action the signed-in role may run. */
function actionColumn(screen: MainScreen, width: number, rows: number): readonly string[] {
  const section = screen.sections[screen.sectionIndex]
  if (section === undefined) return []

  const actions = visibleActions(section, screen.session.role)
  // The column scrolls with the cursor: on a short terminal the selected
  // action must be the one the operator can see, not one below the fold.
  const first = firstVisibleIndex(screen.actionIndex, actions.length, rows)
  return actions.slice(first, first + rows).map((action, index) =>
    padRight(
      `${first + index === screen.actionIndex ? ACTIVE_MARKER : INACTIVE_MARKER}${action.title}`,
      width,
    ),
  )
}

/**
 * The keys the pane on screen answers to. A run in flight speaks first — no
 * other key does anything until it answers — and a pane whose output runs off
 * an edge trades `r refresh` for the two keys that move it.
 */
function footerText(screen: MainScreen, columns: number, bodyRows: number): string {
  if (screen.busy !== undefined) return RUNNING_HELP_FOOTER
  if (screen.pane.kind === 'form') return FORM_HELP_FOOTER

  return isPaneClipped(screen, columns, bodyRows) ? CLIPPED_HELP_FOOTER : KEY_HELP_FOOTER
}

/** Whether the output on screen — if any is on screen — is cut on either side. */
function isPaneClipped(screen: MainScreen, columns: number, bodyRows: number): boolean {
  const { output } = screen
  if (output === undefined || screen.pane.kind !== 'actions') return false

  return isOutputClipped(output, bodyWidthsOf(columns).pane, bodyRows)
}
