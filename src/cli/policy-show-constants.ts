import { ENTRY_POINT_TRUST, ENTRY_POINTS, type TrustClass } from '../policy/source.js'

/**
 * Operator-facing wording for the *bare* `policy show` -- the invocation with
 * no `--entry-point`.
 *
 * The bare command is itself operator-launched (a human typed it in a shell),
 * so it resolves the way `wrap`/`serve`/`ui` do -- and NOT the way an
 * agent-launched `connect` started from the same directory does (ADR-0005,
 * `docs/adr/0005-policy-source-resolution.md`). That difference is invisible in
 * a lone `source:` line: the UI-hardening smoke (finding #8,
 * `docs/smoke-ui-hardening.md`) found an operator reading one file while the
 * agent they were debugging was judged by another, with nothing on screen
 * hinting that a second answer existed.
 *
 * Two lines, printed on every bare invocation, so they must stay short and
 * must not read as a warning: the first names the view, the second names the
 * flag that shows the others. Both entry-point lists are DERIVED from
 * `ENTRY_POINT_TRUST`, so adding an entry point cannot leave this text quietly
 * wrong.
 */
export const BARE_SHOW_TRUST_CLASS: TrustClass = 'operator-launched'

const SAME_RESOLUTION_ENTRY_POINTS = ENTRY_POINTS.filter(
  (entryPoint) => ENTRY_POINT_TRUST[entryPoint] === BARE_SHOW_TRUST_CLASS,
)

export const BARE_SHOW_VIEW_LINES: readonly string[] = [
  `entry point: none given -- ${BARE_SHOW_TRUST_CLASS} view (${SAME_RESOLUTION_ENTRY_POINTS.join(', ')})`,
  `             other views: --entry-point ${ENTRY_POINTS.join('|')}`,
]
