import { padRight, type Style } from './ansi.js'
import type { Model } from './model.js'
import { renderMain } from './render-main.js'
import { blankRows, renderSignIn } from './render-panes.js'

/**
 * The console's renderer (mcpcut phase 2, Task 10): a model and a style in,
 * one frame out.
 *
 * Pure by construction — no terminal, no clock, no store — which is what lets
 * a frame be asserted line by line in a test, and what lets the runtime write
 * it without knowing anything about what it says.
 *
 * This file owns exactly one guarantee, and owns it for both screens: the
 * result is EXACTLY `model.size.rows` lines. The renderers below it aim for
 * that; here it is enforced, because the runtime writes a frame by walking
 * rows and a frame one line short or long would leave the previous frame's
 * tail on screen or scroll the terminal by a line every redraw.
 *
 * Width is the other half of the contract: every line is padded to
 * `model.size.columns` BEFORE a style touches it, so the invisible bytes of
 * an SGR sequence never count as columns. Width is measured in code units
 * (`String#length`) — CJK and emoji are phase 6.
 */
export function render(model: Model, style: Style): readonly string[] {
  const { columns, rows } = model.size
  const lines =
    model.screen.kind === 'signin'
      ? renderSignIn(model.screen, model.size, style)
      : renderMain(model.screen, model.size, style)

  return exactlyRows(lines, rows, columns)
}

/** Cuts a frame down to the terminal's rows, or pads it out to them. */
function exactlyRows(
  lines: readonly string[],
  rows: number,
  columns: number,
): readonly string[] {
  if (rows <= 0) return []
  if (lines.length === rows) return lines
  if (lines.length > rows) return lines.slice(0, rows)

  return [...lines, ...blankRows(rows - lines.length, columns)]
}

