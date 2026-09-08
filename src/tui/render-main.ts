import { padRight, type Style } from './ansi.js'
import { visibleActions } from './catalogue/index.js'
import {
  ACTION_COLUMN_WIDTH,
  ACTIVE_MARKER,
  COLUMN_GAP,
  CONSOLE_TITLE,
  FOOTER_ROWS,
  FORM_HELP_FOOTER,
  HEADER_ROWS,
  HEADER_SEPARATOR,
  INACTIVE_MARKER,
  KEY_HELP_FOOTER,
  RULE_CHAR,
} from './constants.js'
import type { MainScreen, TerminalSize } from './model.js'
import { firstVisibleIndex, paneLines } from './render-panes.js'
import { servicesHeaderPart } from './services-summary.js'

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

/** Separator between two tabs of the section bar. */
const TAB_SEPARATOR = '  '

/** How the body's columns divide up, once the terminal has had its say. */
interface BodyWidths {
  readonly action: number
  readonly gap: number
  readonly pane: number
}

function bodyWidthsOf(columns: number): BodyWidths {
  const action = Math.max(0, Math.min(ACTION_COLUMN_WIDTH, columns))
  const gap = Math.max(0, Math.min(COLUMN_GAP, columns - action))

  return { action, gap, pane: Math.max(0, columns - action - gap) }
}

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
    padRight(footerText(screen), columns),
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
 * The tab bar. The active tab is inversed AFTER the whole line has been
 * padded, and only when the padding did not cut into it: a style applied to
 * an already-truncated span would put its terminator in the wrong place.
 */
function tabsLine(screen: MainScreen, columns: number, style: Style): string {
  const labels = screen.sections.map((section, index) => `${index + 1} ${section.title}`)
  const plain = labels.join(TAB_SEPARATOR)
  const padded = padRight(plain, columns)

  const active = labels[screen.sectionIndex]
  if (active === undefined) return padded

  const start = labels
    .slice(0, screen.sectionIndex)
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

/** The keys the pane on screen answers to. */
function footerText(screen: MainScreen): string {
  return screen.pane.kind === 'form' ? FORM_HELP_FOOTER : KEY_HELP_FOOTER
}
