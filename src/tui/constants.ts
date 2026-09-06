import { BRAND_NAME } from '../brand.js'
import { TOKEN_ONCE_NOTICE } from '../cli/ui-constants.js'

/**
 * The console's own constants — sizes, limits, key hints and the sentences it
 * puts on a screen (plan phase 2, task 2).
 *
 * Per the per-area convention (`src/policy/constants.ts`, `src/services/
 * constants.ts`) the area owns its numbers and its words. Everything the pure
 * core measures or prints is named here rather than typed into a reducer or a
 * renderer: a screen is asserted by tests that compare frames, and a frame
 * built from literals scattered across six modules cannot be changed without
 * hunting them down.
 *
 * The texts a REFUSAL prints before the console ever opens (`tui` on a pipe, a
 * bare run with no install config) are NOT here — they belong to the command,
 * and live in `src/cli/tui-constants.ts` next to it.
 *
 * IMPORT DISCIPLINE: `src/brand.ts` for the product name and
 * `src/cli/ui-constants.ts` for the one-time-token notice, and nothing else.
 * The console is an operator surface like the admin UI, not a part of it, so
 * `src/ui/**` is off limits (`tests/architecture/imports.test.ts`) — which is
 * exactly why `BRAND_NAME` lives in a leaf of its own.
 */

/** Title of the console, shown in the header and on the sign-in screen. */
export const CONSOLE_TITLE = `${BRAND_NAME} console`

/**
 * The size assumed when the terminal does not report one. `columns`/`rows` are
 * `undefined` outside a TTY (a pipe, a test double), and 80×24 is the size
 * every terminal emulator still starts at.
 */
export const DEFAULT_COLUMNS = 80
export const DEFAULT_ROWS = 24

/**
 * The smallest screen the layout is designed for. Below it the console still
 * draws — it clips rather than refusing, because an operator who shrank a pane
 * wants their session back, not an error — so these are the numbers the render
 * tests use as the hard case, not a gate.
 */
export const MIN_COLUMNS = 40
export const MIN_ROWS = 10

/** Width of the left column listing a section's actions, and the gap after it. */
export const ACTION_COLUMN_WIDTH = 24
export const COLUMN_GAP = 2

/** Rows the header takes (title line, section tabs, rule) and the footer's one. */
export const HEADER_ROWS = 3
export const FOOTER_ROWS = 1

/**
 * How many lines of a command's output the panel keeps. A journal export is
 * unbounded, and the console holds its output in memory for scrolling; past
 * this the head is kept and `truncatedNote` says what was dropped.
 */
export const OUTPUT_MAX_LINES = 2000
/** Longest line the panel sanitises; the rest of a monster line is dropped before the regexes see it. */
export const OUTPUT_MAX_LINE_CHARS = 4096
/** Most text a run may leave in memory per stream: the panel shows 2 000 lines, not a journal export. */
export const OUTPUT_MAX_CHARS = 4 * 1024 * 1024

/**
 * How long the key decoder waits for the rest of an escape sequence before
 * reporting a lone `Esc`. Node's default is 500 ms, which is a visible stall
 * on a key that cancels; 100 ms is still far longer than the gap between the
 * bytes of a real sequence arriving from a terminal.
 */
export const ESCAPE_CODE_TIMEOUT_MS = 100

/** How long a quit waits for an effect already in flight before leaving anyway. */
export const QUIT_DRAIN_TIMEOUT_MS = 2_000

/** A console the operator closed itself; and one a signal or a fault closed. */
export const EXIT_OK = 0
export const EXIT_INTERRUPTED = 1

/**
 * Signals the console leaves the screen for. In raw mode `Ctrl-C` is an
 * ordinary key and never reaches `SIGINT`, so these are the ones that arrive
 * from OUTSIDE: a `kill`, or a terminal window closing (`SIGHUP`).
 */
export const DEFAULT_TUI_SIGNALS: readonly NodeJS.Signals[] = Object.freeze([
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
] as NodeJS.Signals[])

/** What a secret field shows instead of what was typed. */
export const SECRET_MASK_CHAR = '•'

/** The text caret drawn after the value of the focused field. */
export const CARET = '▏'

/** Gutter of the action list: the selected row, and every other row. */
export const ACTIVE_MARKER = '▸ '
export const INACTIVE_MARKER = '  '

/**
 * The sentence the CLI prints after a one-time token, without its trailing
 * newline. The console does not know which commands mint tokens — it searches
 * a command's stdout for this marker, and a panel that carries it makes `q`
 * ask first, because the alternate screen takes the token with it.
 */
export const ONE_TIME_TOKEN_MARKER = TOKEN_ONCE_NOTICE.trimEnd()

/** The sign-in screen: its heading and the label of its one field. */
export const SIGNIN_TITLE = 'Sign in'
export const SIGNIN_TOKEN_LABEL = 'Token'

/**
 * The answer to a token that resolves to no admin. Deliberately the same for a
 * token that never existed and one that was rotated or revoked: the console is
 * local and under the same uid as the store, but saying which is which would
 * still turn the screen into an oracle for no gain to the operator.
 */
export const SIGNIN_UNKNOWN_TOKEN_NOTICE =
  'Token not recognised: it may have been rotated, or the admin removed.'

/** Shown on the sign-in screen when a session stopped resolving mid-use. */
export const SESSION_LOST_NOTICE =
  'Session ended: the token no longer resolves to an active admin. Sign in again.'

/** What `q` asks while a one-time token is still on the screen. */
export const QUIT_WITH_TOKEN_QUESTION =
  'The output holds a one-time token that vanishes with this screen. Quit anyway? [y/N]'

/** The footer of the main screen, and of a screen showing a form. */
export const KEY_HELP_FOOTER =
  'Tab sections · ↑↓ actions · Enter run · r refresh · PgUp/PgDn · ? help · q quit'
export const FORM_HELP_FOOTER =
  'Enter run · Tab/↓ next · Shift-Tab/↑ previous · ←/→ change · Esc cancel'

/**
 * The `?` panel: one line per group of keys, covering both footers plus the
 * three bindings a footer has no room for (`Ctrl-C`, `Esc`, and the answer to
 * a confirmation).
 */
export const HELP_LINES: readonly string[] = [
  'Tab / S-Tab / 1-9 / h l move between sections',
  '↑ ↓ / k j               move between the actions of a section',
  'Enter                   open the selected action, or run the form on screen',
  '← →                     change a choice field; space toggles a flag',
  'Tab / Shift-Tab         next / previous field, while a form is open',
  'PgUp / PgDn             scroll the output panel',
  "r                       rerun the section's refresh action",
  'y / n                   answer a confirmation',
  'Esc                     cancel a form or a confirmation; quit on the sign-in screen',
  '?                       show this help',
  'q / Ctrl-C              quit (the services keep running)',
]

/** What the output panel says in place of the lines it did not keep. */
export function truncatedNote(dropped: number): string {
  return `… ${dropped} more line(s) not shown — run the command in a shell for the full output`
}

/** The last line of an output panel: the exit code, written as a shell reports it. */
/** Appended to stderr when a run printed more than `OUTPUT_MAX_CHARS` and the rest was dropped. */
export const OUTPUT_CUT_NOTE =
  'output cut: the command printed more than the console keeps — run it in a shell for the full output'

export function exitLine(code: number): string {
  return `exit ${code}`
}

/**
 * Why the console refuses to open on Windows. Raw mode and the signal
 * semantics it restores the terminal on are POSIX here; the commands
 * themselves are unaffected, so the refusal points at them.
 */
export const WINDOWS_UNSUPPORTED_REASON =
  'the console needs a POSIX terminal (raw mode and signals); on Windows use the commands directly or run under WSL'
