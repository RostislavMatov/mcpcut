import { CLI_NAME } from '../setup/constants.js'
import { sanitizeLine } from './ansi.js'
import { ONE_TIME_TOKEN_MARKER, OUTPUT_MAX_LINES,
  OUTPUT_MAX_LINE_CHARS, truncatedNote } from './constants.js'

/**
 * The output pane: a finished run turned into lines a terminal may draw.
 *
 * Pure and immutable, like the rest of the console's core -- the effect that
 * ran the command hands over its two captured streams and its exit code, and
 * everything the screen shows is derived here, so a panel can be asserted
 * without a terminal.
 *
 * Three disciplines meet in `outputPanelOf`. Safety: a command's text can have
 * come from a proxied MCP server, so every line goes through `sanitizeLine`
 * before it can reach the screen. Bounds: a journal export is unbounded while
 * the console holds its output in memory, so the HEAD is kept -- list headers
 * print first, and a reader who needs the tail has a shell. Secrecy: the
 * command line shows `display`, never `argv`, because a later phase masks a
 * secret in the former while the latter is what was actually dispatched.
 */

/** What one dispatched command left behind. */
export interface RunResult {
  readonly argv: readonly string[]
  /** `argv` as it may be shown: identical today, masked where a secret appears. */
  readonly display: readonly string[]
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** That run, ready to draw: the command line, its lines, and where we are in them. */
export interface OutputPanel {
  readonly command: string
  readonly lines: readonly string[]
  readonly exitCode: number
  readonly scroll: number
  /** Whether stdout holds a token that vanishes with the alternate screen. */
  readonly holdsOneTimeToken: boolean
  readonly truncated: boolean
}

/** Marks where the command's stdout ends and what it wrote to stderr begins. */
export const STDERR_SEPARATOR = '— stderr —'

/**
 * Splits captured text into drawable lines.
 *
 * The split comes first and the sanitising second: `\n` is itself a control
 * character, so sanitising the whole text would collapse every line into one.
 * A trailing newline is a line terminator, not an empty last line, so the
 * empty tail it produces is dropped -- and text that is entirely empty yields
 * no lines at all.
 */
function rawLinesOf(text: string): readonly string[] {
  const lines = text.split('\n')
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines
}

/** One raw line made drawable; capped first so a monster line never reaches the regexes whole. */
function drawable(line: string): string {
  return sanitizeLine(line.slice(0, OUTPUT_MAX_LINE_CHARS))
}

/** Builds the panel a finished run is shown as. */
export function outputPanelOf(result: RunResult): OutputPanel {
  const stdoutLines = rawLinesOf(result.stdout)
  const stderrLines = result.stderr === '' ? [] : [STDERR_SEPARATOR, ...rawLinesOf(result.stderr)]
  const allLines = [...stdoutLines, ...stderrLines]
  const dropped = Math.max(0, allLines.length - OUTPUT_MAX_LINES)
  // Only the lines the panel keeps are sanitised: the head, never the whole.
  const kept = (dropped === 0 ? allLines : allLines.slice(0, OUTPUT_MAX_LINES)).map(drawable)
  const lines = dropped === 0 ? kept : [...kept, truncatedNote(dropped)]

  return {
    command: `$ ${CLI_NAME} ${result.display.join(' ')}`,
    lines,
    exitCode: result.exitCode,
    scroll: 0,
    holdsOneTimeToken: result.stdout.includes(ONE_TIME_TOKEN_MARKER),
    truncated: dropped > 0,
  }
}

/** The furthest the panel scrolls: the last page, never a blank screen. */
function maxScrollOf(panel: OutputPanel, pageRows: number): number {
  return Math.max(0, panel.lines.length - pageRows)
}

/** Moves the view by `delta` lines, clamped to the panel's scrollable range. */
export function scrollOutput(panel: OutputPanel, delta: number, pageRows: number): OutputPanel {
  const scroll = Math.min(Math.max(0, panel.scroll + delta), maxScrollOf(panel, pageRows))
  return { ...panel, scroll }
}

/** Jumps to the last page of the output. */
export function scrollToEnd(panel: OutputPanel, pageRows: number): OutputPanel {
  return { ...panel, scroll: maxScrollOf(panel, pageRows) }
}

/** Jumps back to the first line of the output. */
export function scrollToStart(panel: OutputPanel): OutputPanel {
  return { ...panel, scroll: 0 }
}
