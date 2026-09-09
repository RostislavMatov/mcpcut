import { padRight } from './ansi.js'
import { ACTION_COLUMN_WIDTH, COLUMN_GAP } from './constants.js'

/**
 * How a frame divides up (mcpcut phase 5, owner tail Q24).
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
 */

/** How the body's columns divide up, once the terminal has had its say. */
export interface BodyWidths {
  readonly action: number
  readonly gap: number
  readonly pane: number
}

export function bodyWidthsOf(columns: number): BodyWidths {
  const action = Math.max(0, Math.min(ACTION_COLUMN_WIDTH, columns))
  const gap = Math.max(0, Math.min(COLUMN_GAP, columns - action))

  return { action, gap, pane: Math.max(0, columns - action - gap) }
}

/** Columns the right-hand pane owns on a terminal this wide. */
export function paneWidthOf(columns: number): number {
  return bodyWidthsOf(columns).pane
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
