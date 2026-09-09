import { BRAND_NAME } from '../brand.js'
import { TOKEN_ONCE_NOTICE } from '../cli/ui-constants.js'
import type { DeployStepId, DeployStepState, WizardMode } from './model.js'

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
 * exactly why `BRAND_NAME` lives in a leaf of its own. The wizard's records
 * are keyed by the unions of `model.ts`, imported as TYPES only: `import
 * type` is erased, so this file stays the runtime leaf `model.ts` imports
 * back from.
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
  '[ / ]                   scroll the output pane sideways when a line is cut',
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

// ---------------------------------------------------------------------------
// The first-run wizard (mcpcut phase 3, Task 1)
//
// Every string below is at most `DEFAULT_COLUMNS` wide, and a test says so:
// `padRight` CUTS at the terminal's width, and phase 2 shipped a footer that
// lost its tail on an 80-column terminal because nothing measured it.
// ---------------------------------------------------------------------------

/** Separator between the fields of a title line; shared by the main screen and the wizard. */
export const HEADER_SEPARATOR = ' · '

/** The rule under a header. */
export const RULE_CHAR = '─'

/** What the title line calls the wizard, by mode. */
export const WIZARD_TITLE_FIRST_RUN = 'First run'
export const WIZARD_TITLE_EDIT = 'Setup'

/** The wizard's header is a title and a rule — no tab bar, since there is one screen. */
export const WIZARD_HEADER_ROWS = 2

/** Width of the label column of the wizard's form; wider than the catalogue's, for `TLS in front`. */
export const WIZARD_LABEL_WIDTH = 12

/**
 * The two lines above the form: where the config will go, and what Enter is
 * about to do. Said before anything is written, because the wizard's Enter
 * deploys an install rather than opening another screen.
 */
export function wizardIntroLines(mode: WizardMode, configPath: string): readonly string[] {
  const opening =
    mode === 'edit'
      ? `Edit this install; the config is ${configPath}.`
      : `Welcome. A few answers set up this install; the config goes to ${configPath}.`

  return [opening, 'Enter checks the host, deploys the services and shows the admin token once.']
}

export const WIZARD_FORM_FOOTER =
  'Enter deploy · Tab/↓ next · Shift-Tab/↑ previous · ←/→ change · Esc quit'

/** The confirmation a bind reachable from the network has to pass. */
export const WIZARD_EXPOSURE_INTRO = 'Before anything is written:'
export const WIZARD_EXPOSURE_QUESTION = 'Continue with this bind? [y/N]'
export const WIZARD_EXPOSURE_FOOTER = 'y continue · n back to the form'

/** The deploy ladder: what it is, what each rung is called, and how a state is marked. */
export const DEPLOY_INTRO = 'Deploying — this screen updates as each step completes.'

export const DEPLOY_STEP_TITLES: Readonly<Record<DeployStepId, string>> = {
  setup: 'Checks and config',
  'start-ui': 'Starting ui',
  'start-serve': 'Starting serve',
}

export const DEPLOY_MARKERS: Readonly<Record<DeployStepState, string>> = {
  pending: ' ',
  running: '…',
  done: '✓',
  failed: '✗',
  skipped: '–',
}

/** Column the rung titles are padded to, so every detail starts at the same place. */
export const DEPLOY_TITLE_WIDTH = 22

/**
 * What the deploy transcript shows where `setup` printed the owner token.
 *
 * The wizard shows that token in exactly one place — the final screen, behind
 * a confirmation — so the transcript it also travels in says where it went
 * rather than repeating it under the ladder for as long as the services take
 * to answer.
 */
export const DEPLOY_TOKEN_PLACEHOLDER = '(shown on the final screen)'

/**
 * What a rung says while its service is being waited on. The manager polls the
 * service's probe for up to `START_READY_TIMEOUT_MS`, and one effect yields one
 * message, so this line has to carry the whole wait on its own.
 */
export function deployWaitingDetail(timeoutMs: number): string {
  return `waiting for the service to answer (up to ${Math.round(timeoutMs / 1000)} s)`
}

/** What the `setup` rung says once it is done — with and without a first admin. */
export const DEPLOY_SETUP_DONE_DETAIL = 'config written · vault · signing key'
export const DEPLOY_SETUP_DONE_WITH_OWNER_DETAIL =
  'config written · vault · signing key · owner minted'

/** What a `start` rung says when the services belong to something else. */
export const DEPLOY_EXTERNAL_DETAIL = 'managed by Docker Compose or systemd (supervisor: external)'

/** A rung's detail when the command left nothing else to say. */
export function deployExitDetail(code: number): string {
  return exitLine(code)
}

export const WIZARD_RUNNING_FOOTER = 'working… · Ctrl-C quit'

/** Shown back on the form after a `setup` that did not complete. */
export function wizardFailedNotice(exitCode: number): string {
  return `Setup did not complete (exit ${exitCode}). Adjust the answers and press Enter to retry.`
}

export const WIZARD_FAILED_FOOTER = 'Enter back to the form · q quit'

/**
 * The three ways a deploy ends: everything up, something down, or nothing
 * started here at all. The first is the promise that matters — the services
 * outlive this terminal, which is the whole reason they are daemons.
 */
export const WIZARD_DONE_LINES: readonly string[] = [
  'Setup complete. ui and serve run in the background and keep running after you',
  'close this terminal (mcpcut status · mcpcut stop).',
]
export const WIZARD_DONE_PARTIAL_LINES: readonly string[] = [
  'Not every service started — see "mcpcut logs <service>". The config is written;',
  'you can still sign in.',
]
export const WIZARD_DONE_EXTERNAL_LINES: readonly string[] = [
  'Config written. Services are started by Docker Compose or systemd, not from here',
  '(supervisor: external).',
]

/**
 * The final screen when `setup` minted nobody. The wizard never passes
 * `--no-admin`, so the only way that happens is a data directory that already
 * had admins — a second `mcpcut setup`, or a first run pointed at an existing
 * install. Said in words: the ladder's missing `owner minted` is not a message.
 */
export const WIZARD_NO_ADMIN_LINES: readonly string[] = [
  'No token: the data directory already had admins, so setup created none.',
  'Sign in with an existing owner token. If the last owner lost theirs:',
  'mcpcut admin rotate <name> --recover',
]

/** The label the owner token is printed after, once, on the final screen. */
export function mintedAdminLine(name: string): string {
  return `Owner token for "${name}" (shown once): `
}

/** What the final screen asks while the token is still on it, and the footers of both cases. */
export const WIZARD_TOKEN_QUESTION = 'Saved it? [y/N] — y opens the sign-in screen'
export const WIZARD_TOKEN_FOOTER = 'y sign in · q quit'
export const WIZARD_DONE_FOOTER = 'Enter sign in · q quit'

// ---------------------------------------------------------------------------
// The full catalogue (mcpcut phase 4, Task 1)
//
// Nine more sections than the two of phase 2, which brings three words the
// console did not need before: what a secret looks like in the command line
// the panel prints, how a tab bar that no longer fits reports its edges, and
// what a run whose output went to a file says instead of that output.
// ---------------------------------------------------------------------------

/**
 * What the "equivalent command" line shows in place of a secret argument.
 *
 * Not `SECRET_MASK_CHAR` repeated: the masked argv is read as a command line,
 * and a run of bullets the width of the secret would leak its length to
 * anyone looking over the shoulder. Three asterisks say "a secret was here"
 * and nothing else.
 */
export const SECRET_DISPLAY_MASK = '***'

/** Separator between two tabs of the section bar. */
export const TAB_SEPARATOR = '  '

/**
 * What the tab bar puts at an edge it scrolled past. Eleven sections do not
 * fit in 80 columns, so the bar is a window over the labels, and these two
 * markers are how it admits there is more on either side.
 */
export const TAB_OVERFLOW_LEFT = '‹ '
export const TAB_OVERFLOW_RIGHT = ' ›'

/**
 * Ceiling of the label column of a catalogue form. Phase 2 padded every label
 * to a fixed 8, which the longer labels of the new sections (`Entry point`)
 * overflow; the column is now measured from the labels on screen and clamped
 * here, so one long label cannot push every value off a narrow terminal.
 */
export const FIELD_LABEL_MAX_WIDTH = 12

/**
 * What the output panel says instead of the text a run wrote to a file. An
 * export is unbounded and the panel keeps 2 000 lines, so a run with an
 * output path shows one line of receipt: how much went where.
 */
export function savedToLine(path: string, bytes: number): string {
  return `wrote ${bytes} bytes to ${path}`
}

/**
 * The same receipt for a run whose file could NOT be finished — a write that
 * failed after the file opened, or a close that did. The bytes are the ones
 * that reached the stream, so the sentence must not read like `savedToLine`:
 * an operator handed "wrote 40960 bytes to …" would take an export truncated
 * by ENOSPC for a complete one, and the failure on stderr for a warning.
 */
export function savedPartiallyLine(path: string, bytes: number): string {
  return `wrote ${bytes} bytes to ${path} before failing`
}

/** The hint under the output-path field of `export`; `wx` is why "refused". */
export const EXPORT_OUT_HINT = 'file to write; refused if it exists'

/** The hint under a secret field whose value travels to the command's stdin. */
export const STDIN_SECRET_HINT = 'goes to the command’s stdin, never argv'

