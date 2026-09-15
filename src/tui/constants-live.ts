/**
 * The words and numbers of phase 5 — the live Approvals queue, the one-time
 * token hold and the services banner of the sign-in screen — and of phase 6,
 * which narrows the console, wraps its help, queues its keys and times its
 * wizard.
 *
 * Split from `constants.ts` for the file budget, the way `run-result.ts` left
 * `runtime-effects.ts`: `constants.ts` is at its cap, and a phase's worth of
 * new strings does not fit in it. Nothing here is read by a different rule
 * than the strings there — every one of them is pinned at 80 columns by
 * `tests/tui/constants.test.ts`, because `padRight` cuts a longer line
 * without saying so.
 *
 * A leaf: it imports nothing, so any module of the console may read it.
 */

/**
 * How often the Approvals tab re-reads its own queue while it is on screen
 * (plan P1). Counted from the ANSWER of the previous poll rather than from the
 * tick, so a slow `approvals list` cannot pile requests up behind itself.
 */
export const APPROVALS_POLL_INTERVAL_MS = 3_000

/** Said above the output while a one-time token is on it, and before `y`. */
export const TOKEN_HOLD_BANNER =
  'One-time token on screen: it cannot be shown again and leaves with this screen.'

/** The footer of the token-hold pane: the only keys that do anything there. */
export const TOKEN_HOLD_FOOTER = 'copy the token · y saved it · PgUp/PgDn · [ ] scroll · q quit'

/** Prefix of the sign-in screen's services line, matching the header's own. */
export const SIGNIN_SERVICES_PREFIX = 'services: '

/** What to do about a service the sign-in screen found down, when mcpcut owns it. */
export const SIGNIN_SERVICES_DOWN_HINT =
  'a service marked ○ is down — sign in, then Services ▸ start'

/** …and who to ask instead when something else supervises the daemons (Q16). */
export const SIGNIN_SERVICES_EXTERNAL_HINT =
  'services are managed by compose or systemd (supervisor: external)'

/** The header's glyph for a service that answers but is not ours to start or stop. */
export const EXTERNAL_GLYPH = '◉'

/**
 * Milliseconds in the second every hint and intro line below says out loud.
 * It lives here — a leaf nothing imports back — because the Services
 * catalogue spells the same conversion out for its own hints.
 */
export const MS_PER_SECOND = 1_000

/** The intro line of a tab that re-reads itself, in the whole seconds it does so. */
export function autoRefreshIntroLine(intervalMs: number): string {
  return `This tab re-reads the queue every ${Math.round(intervalMs / MS_PER_SECOND)} s on its own;`
}

// ---------------------------------------------------------------------------
// Phase 6 (polish): the narrow layout, the `?` overlay, the queued keys and
// the wizard's stopwatch. Here rather than in `constants.ts`, which the two
// phase-6 numbers of Task 1 already pushed past its file cap.
// ---------------------------------------------------------------------------

/**
 * Below this many columns the body stacks: the action list above a
 * full-width pane (F1). Two columns of 24 + 2 + 34 leave a pane too narrow
 * for a command line, and the threshold is by columns alone — too few rows
 * is cured by windows, too few columns only by a different layout.
 */
export const NARROW_COLUMNS = 60

/** In the stacked layout the action list gets this share of the body rows (1/3), at least one row. */
export const STACKED_ACTION_ROWS_SHARE = 3

/**
 * Where the description of a `HELP_LINES` entry starts. The lines are already
 * padded to it; the overlay (F3) splits a line that no longer fits there,
 * keys on one line and the description on the next, indented by
 * `HELP_WRAP_INDENT`.
 */
export const HELP_KEY_COLUMN = 24
export const HELP_WRAP_INDENT = 2

/** The last line of the `?` overlay: the one key hint the panel itself needs. */
export const HELP_CLOSE_LINE = 'any key closes this help'

/**
 * The short token banner (F4, Q29), used when the long one would wrap past
 * `TOKEN_HOLD_BANNER_MAX_LINES` in the pane's width. Chosen by the fact of
 * wrapping rather than by a column threshold, so the two-column pane of an
 * 80-column terminal and the full width of a stacked 40 follow one rule.
 */
export const TOKEN_HOLD_BANNER_SHORT = 'One-time token on screen: copy it, then press y.'
export const TOKEN_HOLD_BANNER_MAX_LINES = 2

/**
 * Most keys the console remembers while a run is in flight (F5, Q30). The
 * EARLIEST presses are kept and later ones dropped: a `1 Tab Enter` typed
 * ahead is a plan, and a plan with its head cut off is worse than none.
 */
export const PENDING_KEYS_MAX = 32

/** How often the wizard's `deploying` stage counts a second beside a running `start-*` step (F8). */
export const WIZARD_STOPWATCH_INTERVAL_MS = 1_000

/**
 * Prefix of the sign-in screen's line naming the one-time bootstrap token
 * file, shown while the file exists (F6b). The path follows it uncut where
 * the terminal is wide enough — an operator is meant to copy it.
 */
export const SIGNIN_BOOTSTRAP_PREFIX = 'first owner token: '
