import { TAB_OVERFLOW_LEFT, TAB_OVERFLOW_RIGHT, TAB_SEPARATOR } from './constants.js'

/**
 * Which tabs the section bar can show (mcpcut phase 4, Task 9).
 *
 * Phase 2 had two sections and a static line. Eleven sections are 115 columns
 * of labels, so the bar became a window over them — the same idea as
 * `firstVisibleIndex` in `render-panes.ts`, turned on its side. It needs its
 * own function rather than that one because the items have unequal widths and
 * because the window's own edge markers change its width as they appear: a
 * `‹ ` earns its two columns by taking them from the labels beside it.
 *
 * Pure arithmetic over label widths: no model, no style, no terminal. The
 * renderer decides what a window looks like; this decides only what is in it.
 */

/** A contiguous run of tabs, and which sides it scrolled past. */
export interface TabWindow {
  readonly first: number
  readonly last: number
  readonly hiddenBefore: boolean
  readonly hiddenAfter: boolean
}

/**
 * The run of tabs that fits `columns` and holds `active`.
 *
 * The active tab is inside the window unconditionally — a bar that scrolled
 * away from the section the operator just opened is worse than one that
 * overflows — so a single label wider than the terminal is returned alone and
 * left for `padRight` to cut.
 */
export function tabWindowOf(
  labels: readonly string[],
  active: number,
  columns: number,
): TabWindow {
  const end = labels.length - 1
  if (widthOf(labels, 0, end) <= columns) {
    return { first: 0, last: end, hiddenBefore: false, hiddenAfter: false }
  }

  const start = Math.max(0, Math.min(active, end))
  const last = grownRight(labels, start, columns)
  const first = grownLeft(labels, start, last, columns)

  return { first, last, hiddenBefore: first > 0, hiddenAfter: last < end }
}

/**
 * How wide the bar would be showing `first`…`last`: the labels, a separator
 * between each pair, and a marker for whichever side is scrolled past. The
 * markers are counted here rather than added by the caller because they are
 * what makes growing the window non-monotonic — the last step that reaches
 * the right-hand end also gives back two columns.
 */
function widthOf(labels: readonly string[], first: number, last: number): number {
  if (first > last) return 0

  const shown = labels.slice(first, last + 1)
  const separators = (shown.length - 1) * TAB_SEPARATOR.length
  const left = first > 0 ? TAB_OVERFLOW_LEFT.length : 0
  const right = last < labels.length - 1 ? TAB_OVERFLOW_RIGHT.length : 0

  return shown.reduce((total, label) => total + label.length, 0) + separators + left + right
}

/** The furthest tab to the right of `start` the window can reach. */
function grownRight(labels: readonly string[], start: number, columns: number): number {
  let last = start
  while (last < labels.length - 1 && widthOf(labels, start, last + 1) <= columns) {
    last += 1
  }

  return last
}

/** The furthest tab to the left of `start` the window can reach, once `last` is fixed. */
function grownLeft(
  labels: readonly string[],
  start: number,
  last: number,
  columns: number,
): number {
  let first = start
  while (first > 0 && widthOf(labels, first - 1, last) <= columns) {
    first -= 1
  }

  return first
}
