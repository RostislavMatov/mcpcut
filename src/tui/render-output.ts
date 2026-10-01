import { padRight, sanitizeLine, type Style } from './ansi.js'
import { ACTIVE_MARKER, exitLine, INACTIVE_MARKER } from './constants.js'
import { fillTo } from './layout.js'
import { OUTPUT_CLIP_LEFT_MARKER, OUTPUT_CLIP_MARKER, type OutputPanel } from './output.js'

/**
 * The output pane (mcpcut phase 5, owner tail Q24).
 *
 * Split out of `render-panes.ts` because a pane that admits what it could not
 * show is no longer two lines of slicing: the window now moves in BOTH
 * directions, and every line has to say which of its ends was cut.
 *
 * The one rule that runs through the file is the one the rest of the renderer
 * keeps: a line comes back EXACTLY `width` characters wide. The clip markers
 * are therefore part of the padded line rather than something added to it —
 * a marker appended after padding would push every row one column past the
 * frame the runtime writes.
 *
 * `padRight` is not used for the clipped lines: it would cut with its own
 * ellipsis and put `…›` at the right edge. The sanitising it does happens
 * here instead, first, so the arithmetic below counts the characters that
 * actually reach the terminal.
 */

/** Rows the pane keeps for the command line and for the exit line. */
const OUTPUT_COMMAND_ROWS = 1
const OUTPUT_EXIT_ROWS = 1

/**
 * The output of a finished run. The exit line owns the LAST row of the pane
 * rather than following the text, so scrolling through a long output never
 * scrolls the verdict off the screen — and it is the one row the sideways
 * window does not move, because a verdict half a screen to the right is no
 * verdict at all.
 */
export function outputLines(
  output: OutputPanel,
  width: number,
  rows: number,
  mark?: OutputMark,
): readonly string[] {
  if (rows <= 0) return []

  const head =
    mark === undefined
      ? visibleTextOf(output, rows).map((line) => clippedLine(line, width, output.hScroll))
      : markedLines(output, width, rows, mark)

  return [...fillTo(head, rows - OUTPUT_EXIT_ROWS, width), padRight(exitLine(output.exitCode), width)]
}

/**
 * Whether anything the pane is showing runs off one of its edges — the
 * question the footer answers with the `[` / `]` hint. A window already
 * moved counts on its own: the operator has to be told how to come back.
 */
export function isOutputClipped(output: OutputPanel, width: number, rows: number): boolean {
  if (output.hScroll > 0) return true

  return visibleTextOf(output, rows).some((line) => sanitizeLine(line).length > width)
}

/** The command line and the lines under it that this many rows have room for. */
function visibleTextOf(output: OutputPanel, rows: number): readonly string[] {
  const available = Math.max(0, rows - OUTPUT_COMMAND_ROWS - OUTPUT_EXIT_ROWS)

  return [output.command, ...output.lines.slice(output.scroll, output.scroll + available)]
}

/**
 * One line of the pane, seen through the window that starts at `hScroll`:
 * `‹` where the window cut its head off, `›` where it could not reach its
 * tail, and the columns between them as the line has them.
 *
 * A marker REPLACES the cell it sits in rather than pushing the text along.
 * That is what keeps the arithmetic honest at both ends: the reducer clamps
 * the window at `longest line − pane width`, and a marker that stole a column
 * would leave the last character of the longest line permanently one column
 * out of reach.
 */
function clippedLine(text: string, width: number, hScroll: number): string {
  if (width <= 0) return ''

  const safe = sanitizeLine(text)
  const cells = safe.slice(hScroll, hScroll + width).padEnd(width)
  if (width === 1) return hScroll > 0 ? OUTPUT_CLIP_LEFT_MARKER : cells

  const left = hScroll > 0 ? OUTPUT_CLIP_LEFT_MARKER : cells.slice(0, 1)
  const right = safe.length > hScroll + width ? OUTPUT_CLIP_MARKER : cells.slice(width - 1)

  return `${left}${cells.slice(1, width - 1)}${right}`
}

/**
 * One line of the output picked out (Approvals ▸ list, `approval-pick.ts`):
 * every line gets a two-column gutter, the picked one `▸ ` and inverse video.
 * The marker, not the inversion alone, is what shows under `NO_COLOR` and
 * `TERM=dumb` (Q33). `line` indexes `OutputPanel.lines`.
 */
export interface OutputMark {
  readonly line: number
  readonly style: Style
}

function markedLines(output: OutputPanel, width: number, rows: number, mark: OutputMark): readonly string[] {
  const textWidth = Math.max(0, width - ACTIVE_MARKER.length)
  // Row 0 is the command line; row k shows `lines[scroll + k - 1]`.
  return visibleTextOf(output, rows).map((text, row) => {
    const clipped = clippedLine(text, textWidth, output.hScroll)
    const picked = row >= OUTPUT_COMMAND_ROWS && output.scroll + row - OUTPUT_COMMAND_ROWS === mark.line
    return picked ? mark.style.inverse(`${ACTIVE_MARKER}${clipped}`) : `${INACTIVE_MARKER}${clipped}`
  })
}
