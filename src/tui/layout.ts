import { padRight } from './ansi.js'
import { ACTION_COLUMN_WIDTH, COLUMN_GAP, FOOTER_ROWS, HEADER_ROWS } from './constants.js'
import { NARROW_COLUMNS, STACKED_ACTION_ROWS_SHARE } from './constants-live.js'
import type { TerminalSize } from './model.js'

/**
 * How a frame divides up (mcpcut phase 5, owner tail Q24; phase 6, F1).
 *
 * A leaf below both halves of the console: the renderers build lines from
 * these widths, and the reducer needs the same pane width to clamp the
 * output pane's sideways scroll. Keeping the arithmetic here is what stops
 * "how wide is the pane" from being answered twice and drifting — a frame
 * whose lines disagree with the reducer's clamp scrolls past its own text.
 *
 * Widths are clamped rather than assumed: a terminal narrower than the
 * layout gets a pane of zero columns and a clipped action column, because an
 * operator who shrank a window wants their session back, not a refusal.
 *
 * Phase 6 adds the second dimension. Below `NARROW_COLUMNS` the body stacks:
 * a band of actions on top, a blank row, then a pane the full width of the
 * terminal. `bodyWidthsOf` stays as the two-column case so every caller that
 * only ever asked for widths keeps its answer; `bodyLayoutOf` is the one
 * that also says how many ROWS each part owns.
 */

/** How the body's columns divide up, once the terminal has had its say. */
export interface BodyWidths {
  readonly action: number
  readonly gap: number
  readonly pane: number
}

export type LayoutMode = 'two-column' | 'stacked'

export interface BodyLayout {
  readonly mode: LayoutMode
  /** Two-column: the three widths; stacked: action = pane = columns, gap = 0. */
  readonly widths: BodyWidths
  /** Rows the action list may use (stacked: a band; two-column: the whole body). */
  readonly actionRows: number
  /** Rows the pane may use (stacked: the body minus the band and one blank row). */
  readonly paneRows: number
}

/** The slice of a list that is on screen: `first`..`last` inclusive, empty when `last < first`. */
export interface ActionWindow {
  readonly first: number
  readonly last: number
}

/** The blank row between the band and the pane in the stacked layout. */
const STACKED_SEPARATOR_ROWS = 1

/** The band never vanishes: with one row the active action is still on screen. */
const MIN_BAND_ROWS = 1

/**
 * What `bodyLayoutOf` assumes about the number of actions when nobody said.
 * `Math.min(count, band)` with this leaves the band alone, which errs on the
 * side of a SMALLER pane: `pageRowsOf` reads `paneRows` off this layout, and a
 * page that scrolls by fewer rows than the pane shows is a nuisance, whereas
 * one that scrolls by more skips text.
 */
const UNKNOWN_ACTION_COUNT = Number.POSITIVE_INFINITY

export function bodyWidthsOf(columns: number): BodyWidths {
  const action = Math.max(0, Math.min(ACTION_COLUMN_WIDTH, columns))
  const gap = Math.max(0, Math.min(COLUMN_GAP, columns - action))

  return { action, gap, pane: Math.max(0, columns - action - gap) }
}

/** Columns the right-hand pane owns on a terminal this wide. */
export function paneWidthOf(columns: number): number {
  return bodyWidthsOf(columns).pane
}

/** Rows between the header and the footer on a terminal this tall. */
function bodyRowsOf(size: TerminalSize): number {
  return Math.max(0, size.rows - HEADER_ROWS - FOOTER_ROWS)
}

/**
 * The body's layout for a whole terminal, with the action count unknown —
 * what the reducer asks for a page size. The band takes its full share here
 * (see `UNKNOWN_ACTION_COUNT`); a renderer that knows the count uses
 * `bodyLayoutOfRows` and gets a taller pane when the list is short.
 */
export function bodyLayoutOf(size: TerminalSize): BodyLayout {
  return bodyLayoutOfRows(size.columns, bodyRowsOf(size), UNKNOWN_ACTION_COUNT)
}

/**
 * The body's layout given its rows and the number of actions on show.
 * Stacked: `band = min(actionCount, max(1, floor(bodyRows / SHARE)))` and the
 * pane gets what is left after the band and one blank row.
 */
export function bodyLayoutOfRows(columns: number, bodyRows: number, actionCount: number): BodyLayout {
  const rows = Math.max(0, bodyRows)
  if (columns >= NARROW_COLUMNS) {
    return { mode: 'two-column', widths: bodyWidthsOf(columns), actionRows: rows, paneRows: rows }
  }

  const share = Math.floor(rows / STACKED_ACTION_ROWS_SHARE)
  const actionRows = Math.min(actionCount, Math.max(MIN_BAND_ROWS, share))
  const paneRows = Math.max(0, rows - actionRows - STACKED_SEPARATOR_ROWS)

  return { mode: 'stacked', widths: { action: columns, gap: 0, pane: columns }, actionRows, paneRows }
}

/**
 * The slice of `count` items that keeps `active` visible in `rows` rows. The
 * window scrolls only once the active item has left the bottom, and never
 * past the end of the list, so a list shorter than the window starts at 0.
 */
export function actionWindowOf(count: number, active: number, rows: number): ActionWindow {
  const furthest = Math.max(0, count - rows)
  const first = Math.min(furthest, Math.max(0, active - rows + 1))
  const last = Math.min(count - 1, first + rows - 1)

  return { first, last }
}

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
 * Breaks a question at spaces so its answer is never cut off by the pane:
 * a confirmation that hides its own "[y/N]" behind an ellipsis is worse than
 * none. A single word longer than the pane still falls to `fitWidth`.
 *
 * Here rather than in `render-panes.ts` since phase 6, because the help
 * overlay and the wizard wrap text too and this is the leaf both can reach.
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
