import { padRight } from './ansi.js'
import { HELP_LINES } from './constants.js'
import { HELP_CLOSE_LINE, HELP_KEY_COLUMN, HELP_WRAP_INDENT } from './constants-live.js'
import { wrapWords } from './layout.js'

/**
 * The `?` overlay (mcpcut phase 6, F3): the key bindings, drawn over the
 * whole body rather than inside the pane beside the action column.
 *
 * `HELP_LINES` are written for 80 columns, each a key part padded out to
 * `HELP_KEY_COLUMN` and a description after it. A line that fits the width it
 * is given is kept as it is — the two-column look of the wide terminal must
 * not change. One that does not is split at the key column: the keys on a
 * line of their own, the description wrapped under them and indented, so the
 * eye still finds the key first and the meaning second.
 *
 * A leaf: it reaches only the constants, `padRight` and the layout leaf, so
 * both renderers of the body can agree on the same lines.
 */

/** HELP_LINES at `width`: a line that fits is kept; a wider one splits at the key column, its description wrapped and indented (F3). */
export function helpLines(width: number, rows: number): readonly string[] {
  const wrapped = HELP_LINES.flatMap((line) => helpEntryLines(line, width))

  // No scrolling: the overlay is one screenful and the key that closes it is
  // any key, so a 20×5 terminal honestly shows the first lines and nothing
  // else — a scrollable help would need keys of its own to move it.
  return [...wrapped, '', HELP_CLOSE_LINE]
    .slice(0, Math.max(0, rows))
    .map((line) => padRight(line, width))
}

/** One entry of `HELP_LINES` at `width`: whole when it fits, keys-then-description otherwise. */
function helpEntryLines(line: string, width: number): readonly string[] {
  if (line.length <= width) return [line]

  const keys = line.slice(0, HELP_KEY_COLUMN).trimEnd()
  const description = line.slice(HELP_KEY_COLUMN).trim()
  const indent = ' '.repeat(HELP_WRAP_INDENT)

  return [
    keys,
    ...wrapWords(description, width - HELP_WRAP_INDENT).map((piece) => `${indent}${piece}`),
  ]
}
