/**
 * Escape sequences and text helpers the console renders with.
 *
 * Two disciplines live here. The first is the screen itself: the console runs
 * on the alternate buffer, so it never scribbles over the user's scrollback,
 * and every frame is written over the previous one line by line rather than
 * after a full clear, which is what keeps the picture from flickering.
 *
 * The second is terminal safety. The output pane prints what a command
 * printed, and that text can have come from a proxied MCP server -- untrusted
 * input by the same argument as `journal/format.ts`. Raw escape sequences
 * there would move our cursor, repaint our frame or hide output, so every
 * line goes through `sanitizeLine` before it reaches the screen. Unlike the
 * journal's readable view there is no length cap: the renderer cuts lines to
 * the terminal's width, which is the only cap that means anything here.
 *
 * Leaf module: it imports nothing, so the pure render layer stays testable
 * without a terminal.
 */

/** Switches the terminal to the alternate screen buffer (xterm private mode 1049). */
export const ALT_SCREEN_ON = '\x1b[?1049h'

/** Returns the terminal to the primary screen buffer, restoring the scrollback. */
export const ALT_SCREEN_OFF = '\x1b[?1049l'

/** Hides the hardware cursor while the console draws its own. */
export const CURSOR_HIDE = '\x1b[?25l'

/** Shows the hardware cursor again. */
export const CURSOR_SHOW = '\x1b[?25h'

/** Moves the cursor to row 1, column 1 -- the start of every frame. */
export const CURSOR_HOME = '\x1b[H'

/** Erases from the cursor to the end of the line, so a shorter line hides a longer one. */
export const CLEAR_TO_LINE_END = '\x1b[K'

/** Erases from the cursor to the end of the screen, so a shorter frame hides a taller one. */
export const CLEAR_BELOW = '\x1b[J'

/** Everything the console writes on the way in, in the order a terminal expects it. */
export const ENTER_SCREEN = ALT_SCREEN_ON + CURSOR_HIDE

/** Everything the console writes on the way out; the mirror image of `ENTER_SCREEN`. */
export const LEAVE_SCREEN = CURSOR_SHOW + ALT_SCREEN_OFF

/**
 * Text attributes as a seam. `render` takes a `Style` instead of writing SGR
 * codes itself, so tests can compare frames as plain text and a future
 * `NO_COLOR`/`TERM=dumb` mode is a different value, not a different renderer.
 */
export interface Style {
  bold(text: string): string
  inverse(text: string): string
  dim(text: string): string
}

/** The identity style: no attributes, no invisible bytes in the frame. */
export const plainStyle: Style = {
  bold: (text) => text,
  inverse: (text) => text,
  dim: (text) => text,
}

/** The real style: SGR attributes, each turned off by its own reset code (never SGR 0). */
export const ansiStyle: Style = {
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  inverse: (text) => `\x1b[7m${text}\x1b[27m`,
  dim: (text) => `\x1b[2m${text}\x1b[22m`,
}

/** A CSI sequence: ESC [ parameter bytes, intermediate bytes, one final byte. */
const CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g

/** An OSC sequence: ESC ] up to its BEL or ST terminator (window titles, hyperlinks). */
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/**
 * The 8-bit twins of the sequences above. xterm and its kin honour them
 * exactly like the ESC-prefixed forms — U+009B is a CSI, U+009D an OSC that
 * can write the clipboard — and they arrive as ordinary UTF-8 text. A CSI
 * ends at its final byte; a string (OSC, DCS, SOS, PM, APC) runs to its
 * terminator, or to the end of the line when it has none.
 */
const C1_CSI_PATTERN = /\u009b[0-?]*[ -/]*[@-~]/g
const C1_STRING_PATTERN = /[\u0090\u0098\u009d-\u009f][^\u009c\x07]*(?:\u009c|\x07)?/g

/**
 * Bidi controls, zero-width and other format characters: invisible on
 * screen, but they reorder or hide what the operator reads. The same class
 * `src/ui/display-name.ts` strips for the same reason on the web surface.
 */
const INVISIBLE_PATTERN = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu

/** C0 and C1 control characters plus DEL: never safe to print to a terminal raw. */
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f-\x9f]/g

/** What a control character that survived the sequence passes is replaced with. */
const CONTROL_CHAR_REPLACEMENT = '?'

/** Marker that stands in for the part of a line the width could not hold. */
const TRUNCATION_MARKER = '…'

/**
 * Makes one line of untrusted text safe to draw.
 *
 * The order is load-bearing: whole sequences go first, control characters
 * second. The other way round, the ESC of `\x1b[2K` would become `?` and its
 * `[2K` tail would stay on screen as literal noise.
 */
export function sanitizeLine(line: string): string {
  return line
    .replace(CSI_PATTERN, '')
    .replace(OSC_PATTERN, '')
    .replace(C1_CSI_PATTERN, '')
    .replace(C1_STRING_PATTERN, '')
    .replace(INVISIBLE_PATTERN, '')
    .replace(CONTROL_CHAR_PATTERN, CONTROL_CHAR_REPLACEMENT)
}

/**
 * Cuts `text` down to `width` columns, marking a cut with an ellipsis so the
 * reader can tell a short value from a truncated one. A width of zero or less
 * (a terminal narrower than the layout) yields an empty string rather than a
 * negative slice.
 */
export function fitWidth(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  return `${text.slice(0, width - 1)}${TRUNCATION_MARKER}`
}

/**
 * Sanitised, fitted, then padded out: the result is exactly `width`
 * characters wide. Every cell of a frame passes through here before any
 * style is applied, which is what makes "nothing reaches the terminal raw" a
 * property of the renderer rather than a habit of each pane.
 */
export function padRight(text: string, width: number): string {
  return fitWidth(sanitizeLine(text), width).padEnd(width)
}

/**
 * Joins rendered lines into one frame. Each line ends with an erase-to-line-end
 * so it fully replaces whatever the previous frame left there, and the frame
 * ends with an erase-below so a shorter frame does not leave a taller one's
 * tail on screen -- all without a clear-screen, which is what would flicker.
 */
export function frameOf(lines: readonly string[]): string {
  return `${CURSOR_HOME}${lines.join(`${CLEAR_TO_LINE_END}\r\n`)}${CLEAR_TO_LINE_END}${CLEAR_BELOW}`
}
