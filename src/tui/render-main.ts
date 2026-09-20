import { padRight, sanitizeLine, type Style } from './ansi.js'
import { visibleActions } from './catalogue/index.js'
import type { ActionSpec } from './catalogue/types.js'
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
} from './constants.js'
import { TOKEN_HOLD_FOOTER } from './constants-live.js'
import { actionWindowOf, type BodyLayout, bodyLayoutOfRows, fillTo } from './layout.js'
import type { InstallFacts, MainScreen, TerminalSize } from './model.js'
import { helpLines } from './render-help.js'
import { isOutputClipped } from './render-output.js'
import { paneLines } from './render-panes.js'
import { servicesHeaderPart } from './services-summary.js'
import { tabWindowOf } from './tabs.js'
import {
  TAB_ACTIVE_MARK,
  TAB_IDLE_MARK,
  TAB_OVERFLOW_LEFT,
  TAB_OVERFLOW_RIGHT,
  TAB_SEPARATOR,
} from './tabs-constants.js'

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
 * Since phase 6 (F1) the body has a second shape. `layout.ts` decides: below
 * `NARROW_COLUMNS` it stacks — a band of actions, a blank row, a pane the
 * full width of the terminal — and the band is drawn only on the `actions`
 * pane, since a form or a question wants every row it can get. The `?` pane
 * (F3) is the one that ignores the layout in both shapes: it is an overlay
 * over the whole body. Nothing here measures a width itself; every number
 * comes from the layout, so the reducer's clamps and these lines agree.
 */

/**
 * The footer while a run is in flight (owner tail Q22).
 *
 * Phase 5 said keys were IGNORED, because `update.ts` made the keyboard deaf
 * until the run answered and a slow command read as a wedged console. Since
 * phase 6 (F5, Q30) the reducer queues them and replays them after the run,
 * so the footer says so — the one line that tells an operator typing ahead
 * is safe.
 */
export const RUNNING_HELP_FOOTER =
  'running… · keys are queued until it finishes · Ctrl-C aborts'

/**
 * The footer while the output pane is cut on either side (owner tail Q24). It
 * buys the room for `[ ] scroll` by dropping `r refresh`, which is the one
 * hint of the normal footer that belongs to the section rather than to the
 * pane the operator is reading.
 */
export const CLIPPED_HELP_FOOTER =
  'Tab sections · ↑↓ actions · Enter run · PgUp/PgDn · [ ] scroll · ? help · q quit'

/**
 * The whole main screen, header to footer. `install` is optional and threaded
 * through only for the header's remote address (2026-09-20) — the local
 * header is byte-for-byte what it always was, `install` absent or not remote.
 */
export function renderMain(
  screen: MainScreen,
  size: TerminalSize,
  style: Style,
  install?: InstallFacts,
): readonly string[] {
  const { columns, rows } = size
  const bodyRows = Math.max(0, rows - HEADER_ROWS - FOOTER_ROWS)

  return [
    style.bold(padRight(headerText(screen, install), columns)),
    tabsLine(screen, columns, style),
    RULE_CHAR.repeat(Math.max(0, columns)),
    ...bodyLines(screen, columns, bodyRows, style),
    padRight(footerText(screen, columns, bodyRows), columns),
  ]
}

/**
 * `McpCut console · kate (owner) @ plane.example.com:8091 · services: …`
 * (2026-09-20): the address rides on the SAME segment as the name and role,
 * `@ host[:port]` — host and port only, never the scheme, and sanitised like
 * every other value this console did not itself compute (the header already
 * degrades to a shorter line on a narrow terminal, exactly as it always has:
 * nothing here is aware of the width it will be padded or cut to).
 */
function headerText(screen: MainScreen, install: InstallFacts | undefined): string {
  const { adminName, role } = screen.session
  const address = install?.remote === true ? install.remoteAddress : undefined
  const identity = address === undefined ? `${adminName} (${role})` : `${adminName} (${role}) @ ${hostPortOf(address)}`

  return [CONSOLE_TITLE, identity, servicesHeaderPart(screen.services)].join(HEADER_SEPARATOR)
}

/** An origin (`scheme://host[:port]`) reduced to `host[:port]` — never the scheme. */
function hostPortOf(origin: string): string {
  try {
    const url = new URL(origin)
    return sanitizeLine(url.port === '' ? url.hostname : `${url.hostname}:${url.port}`)
  } catch {
    // A malformed address should not have reached here (`parseRemoteUrl`
    // refuses it long before this screen exists) — sanitised as-is rather
    // than thrown, since a header is drawn far too often to risk a crash on it.
    return sanitizeLine(origin)
  }
}

/**
 * The tab bar: a window over the section labels, since eleven of them are
 * half again as wide as an 80-column terminal (`tabs.ts` decides which fit).
 *
 * Every label carries a one-column mark in front, `TAB_ACTIVE_MARK` on the
 * active one, so the bar tells the tabs apart in every style (Q33).
 *
 * The active tab is inversed AFTER the whole line has been padded, and only
 * when the padding did not cut into it: a style applied to an already-
 * truncated span would put its terminator in the wrong place.
 */
function tabsLine(screen: MainScreen, columns: number, style: Style): string {
  const labels = screen.sections.map((section, index) =>
    `${index === screen.sectionIndex ? TAB_ACTIVE_MARK : TAB_IDLE_MARK}${index + 1} ${section.title}`,
  )
  const window = tabWindowOf(labels, screen.sectionIndex, columns)
  const left = window.hiddenBefore ? TAB_OVERFLOW_LEFT : ''
  const right = window.hiddenAfter ? TAB_OVERFLOW_RIGHT : ''
  const plain = `${left}${labels.slice(window.first, window.last + 1).join(TAB_SEPARATOR)}${right}`
  const padded = padRight(plain, columns)

  const active = labels[screen.sectionIndex]
  if (active === undefined || screen.sectionIndex < window.first) return padded

  // The inversion covers the label without its mark: the mark is what tells
  // the active tab apart when there is no colour at all (Q33).
  const start = TAB_ACTIVE_MARK.length + left.length + labels
    .slice(window.first, screen.sectionIndex)
    .reduce((total, label) => total + label.length + TAB_SEPARATOR.length, 0)
  const end = start + active.length - TAB_ACTIVE_MARK.length
  const limit = plain.length > columns ? Math.max(0, columns - 1) : padded.length
  if (end > limit) return padded

  return `${padded.slice(0, start)}${style.inverse(padded.slice(start, end))}${padded.slice(end)}`
}

/** The body: the help overlay, or the action list and the pane in the layout's shape. */
function bodyLines(
  screen: MainScreen,
  columns: number,
  rows: number,
  style: Style,
): readonly string[] {
  if (rows <= 0) return []

  const layout = bodyLayoutOfRows(columns, rows, actionsOf(screen).length)
  // F3: help is an overlay in both layouts — the one pane that takes the
  // action column's place, because its lines are written for the full width.
  if (screen.pane.kind === 'help') return fillTo(helpLines(columns, rows), rows, columns)
  if (layout.mode === 'stacked') return stackedBody(screen, columns, layout, rows, style)

  return twoColumnBody(screen, layout, rows, style)
}

/** The wide shape: the action column and the pane, joined row by row. */
function twoColumnBody(
  screen: MainScreen,
  layout: BodyLayout,
  rows: number,
  style: Style,
): readonly string[] {
  const { widths } = layout
  const actions = actionColumn(screen, widths.action, layout.actionRows)
  const pane = paneLines(screen, widths.pane, layout.paneRows, style)
  const gap = ' '.repeat(widths.gap)

  return Array.from(
    { length: rows },
    (_, index) => `${actions[index] ?? padRight('', widths.action)}${gap}${pane[index] ?? padRight('', widths.pane)}`,
  )
}

/**
 * The narrow shape (F1): on the `actions` pane a band of actions, a blank
 * row and the pane under it; on any other pane the pane alone, because a
 * form or a question is what the operator is on and the list would only
 * take rows from it. The band is filled to its row count BEFORE the pane
 * is appended, so the pane starts on the same row whatever the list holds.
 */
function stackedBody(
  screen: MainScreen,
  columns: number,
  layout: BodyLayout,
  rows: number,
  style: Style,
): readonly string[] {
  if (screen.pane.kind !== 'actions') return fillTo(paneLines(screen, columns, rows, style), rows, columns)

  const band = fillTo(actionColumn(screen, columns, layout.actionRows), layout.actionRows, columns)
  const pane = paneLines(screen, columns, layout.paneRows, style)

  return fillTo([...band, padRight('', columns), ...pane], rows, columns)
}

/** The actions of the open section the signed-in role may run — none when there is no section. */
function actionsOf(screen: MainScreen): readonly ActionSpec[] {
  const section = screen.sections[screen.sectionIndex]
  if (section === undefined) return []

  return visibleActions(section, screen.session.role)
}

/**
 * The action list: one row per action, cut to the window that keeps the
 * selected one on screen — on a short terminal, or in the stacked band, the
 * selected action must be the one the operator can see, not one below the
 * fold. The window is the layout's (`actionWindowOf`), the same in both shapes.
 */
function actionColumn(screen: MainScreen, width: number, rows: number): readonly string[] {
  const actions = actionsOf(screen)
  const window = actionWindowOf(actions.length, screen.actionIndex, rows)

  return actions.slice(window.first, window.last + 1).map((action, index) =>
    padRight(
      `${window.first + index === screen.actionIndex ? ACTIVE_MARKER : INACTIVE_MARKER}${action.title}`,
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
  // A held token is the one pane where the ordinary hints would be a lie:
  // Tab, ↑↓, Enter and r are all ignored until the operator says they copied
  // it (plan P2), so the footer names only the keys that still do anything.
  if (screen.pane.kind === 'token-hold') return TOKEN_HOLD_FOOTER
  if (screen.pane.kind === 'form') return FORM_HELP_FOOTER

  return isPaneClipped(screen, columns, bodyRows) ? CLIPPED_HELP_FOOTER : KEY_HELP_FOOTER
}

/**
 * Whether the output on screen — if any is on screen — is cut on either side.
 * The pane's width and rows come from the layout: in the stacked shape the
 * pane is the whole terminal wide, and a footer that measured the two-column
 * pane would offer `[ ] scroll` for a line that is not cut at all.
 */
function isPaneClipped(screen: MainScreen, columns: number, bodyRows: number): boolean {
  const { output } = screen
  if (output === undefined || screen.pane.kind !== 'actions') return false

  const layout = bodyLayoutOfRows(columns, bodyRows, actionsOf(screen).length)
  return isOutputClipped(output, layout.widths.pane, layout.paneRows)
}
