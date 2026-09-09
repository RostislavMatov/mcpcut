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
  /** `argv` as it may be shown: the same command line, with every secret VALUE masked. */
  readonly display: readonly string[]
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  /**
   * The action that ran prints a credential once (`RunRequest.mintsToken`);
   * absent for every other command. It is what makes `holdsOneTimeToken` a
   * fact about the run rather than about its text.
   */
  readonly mintsToken?: true
}

/** That run, ready to draw: the command line, its lines, and where we are in them. */
export interface OutputPanel {
  readonly command: string
  readonly lines: readonly string[]
  readonly exitCode: number
  readonly scroll: number
  /**
   * First column of the lines the pane draws (owner tail Q24). The pane is 54
   * columns on the terminal every emulator starts at, which is narrower than
   * `server list`; `]` and `[` move this window over the rest.
   */
  readonly hScroll: number
  /**
   * Whether a MINTING action's stdout holds a token that vanishes with the
   * alternate screen. Both halves matter — see `holdsTokenOf`.
   */
  readonly holdsOneTimeToken: boolean
  /**
   * Whether the operator has said they saved that token. A panel starts
   * unacknowledged, and only `y` on the token-hold pane sets it — which is
   * what lets `q`, a quiet poll and the panes stop asking afterwards.
   */
  readonly tokenAcknowledged: boolean
  readonly truncated: boolean
}

/** Columns one press of `]` or `[` moves the window sideways. */
export const OUTPUT_HSCROLL_STEP = 8

/** Drawn in the LAST column of a line the pane could not finish. */
export const OUTPUT_CLIP_MARKER = '›'

/** Drawn in the FIRST column of a line the pane starts part-way into. */
export const OUTPUT_CLIP_LEFT_MARKER = '‹'

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

/**
 * Whether this run really put a one-time credential on the screen.
 *
 * BOTH halves are required, and the first one is the security property. The
 * marker is an English sentence, and most commands print text somebody else
 * wrote — `approvals list` prints the arguments an agent sent, `journal show`
 * and `logs` print upstream bytes — so a match on stdout alone let anyone who
 * could get that sentence printed put the console into the modal token pane
 * under a banner that was a lie. Only an action declared as minting one may.
 * The second half keeps the pane honest the other way: a refused `admin add`
 * prints no token, and must not hold the screen for one.
 */
function holdsTokenOf(result: RunResult): boolean {
  return result.mintsToken === true && result.stdout.includes(ONE_TIME_TOKEN_MARKER)
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
    hScroll: 0,
    holdsOneTimeToken: holdsTokenOf(result),
    tokenAcknowledged: false,
    truncated: dropped > 0,
  }
}

/** The same panel, with the operator's "I saved it" recorded on it. */
export function acknowledgeToken(panel: OutputPanel): OutputPanel {
  return { ...panel, tokenAcknowledged: true }
}

/**
 * Whether the screen may not be replaced or taken away yet: a token is on it
 * and nobody has said they copied it (PRD C6). Absent output holds nothing.
 */
export function needsTokenHold(panel: OutputPanel | undefined): boolean {
  return panel?.holdsOneTimeToken === true && !panel.tokenAcknowledged
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

/**
 * The widest line the panel holds, command line included: the command is
 * drawn in the same window as the output and scrolls with it.
 */
function maxLineWidthOf(panel: OutputPanel): number {
  return panel.lines.reduce((widest, line) => Math.max(widest, line.length), panel.command.length)
}

/**
 * Moves the window sideways by `steps` presses, clamped so it never starts
 * before the first column nor past the end of the longest line — `]` at the
 * right-hand end is a no-op rather than an endless drift into blank columns.
 */
export function scrollOutputSideways(
  panel: OutputPanel,
  steps: number,
  paneWidth: number,
): OutputPanel {
  const furthest = Math.max(0, maxLineWidthOf(panel) - Math.max(0, paneWidth))
  const hScroll = Math.min(Math.max(0, panel.hScroll + steps * OUTPUT_HSCROLL_STEP), furthest)

  return hScroll === panel.hScroll ? panel : { ...panel, hScroll }
}

/**
 * What the pane shows after a quiet poll answered (plan P9).
 *
 * Two things the poll must not do. It must not wipe a FAILED run of another
 * command: nobody asked for the poll, and the error is what the operator was
 * about to read. And it must not throw away where they had scrolled to in the
 * output of the same command, which would make a live tab unreadable — so both
 * offsets are carried over and re-clamped against the new text.
 */
export function replacedOutput(
  previous: OutputPanel | undefined,
  next: OutputPanel,
  pageRows: number,
  paneWidth: number,
): OutputPanel {
  if (previous === undefined) return next
  if (previous.exitCode !== 0 && previous.command !== next.command) return previous
  if (previous.command !== next.command) return next

  const scrolled = scrollOutput(next, previous.scroll, pageRows)
  // `hScroll` is in columns and `scrollOutputSideways` takes presses of `]`.
  return scrollOutputSideways(scrolled, previous.hScroll / OUTPUT_HSCROLL_STEP, paneWidth)
}
