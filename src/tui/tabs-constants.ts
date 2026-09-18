import { ACTIVE_MARKER } from './constants.js'

/**
 * The glyphs of the section tab bar: the gap between labels, the mark of the
 * active tab and the markers at an edge the bar scrolled past.
 *
 * Split from `constants.ts` for the file budget, the way `constants-live.ts`
 * was: `constants.ts` crossed 400 lines once Q33 gave every tab a mark, and
 * these five form one cohesive group read only by the tab bar (`tabs.ts`,
 * `render-main.ts`). No import cycle: `constants.ts` never imports this
 * file, and the active mark stays derived from `ACTIVE_MARKER` so the tab bar
 * and the action list cannot drift to different cursor glyphs.
 */

/**
 * Separator between two tabs of the section bar. One column, not two: each
 * label also carries a one-column mark in front (Q33), so an idle mark plus
 * this separator keep the old two-space gap between labels.
 */
export const TAB_SEPARATOR = ' '

/**
 * The mark in front of the active tab — the action list's cursor glyph.
 *
 * Inversion alone is invisible under `NO_COLOR` and `TERM=dumb` (Q33), so the
 * active tab needs a sign that survives without any SGR. The mark sits
 * outside the inversion in the ansi style.
 */
export const TAB_ACTIVE_MARK = ACTIVE_MARKER.trimEnd()

/** The mark in front of every other tab: a blank of the same width, so labels do not shift. */
export const TAB_IDLE_MARK = ' '

/**
 * What the tab bar puts at an edge it scrolled past. Eleven sections do not
 * fit in 80 columns, so the bar is a window over the labels, and these two
 * markers are how it admits there is more on either side.
 */
export const TAB_OVERFLOW_LEFT = '‹ '
export const TAB_OVERFLOW_RIGHT = ' ›'
