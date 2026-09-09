/**
 * The words and numbers of phase 5 — the live Approvals queue, the one-time
 * token hold and the services banner of the sign-in screen.
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
