/**
 * Constants of the shared upstream layer (`src/upstream/*`) — the code that
 * turns a registry record into a live transport, extracted from
 * `src/cli/connect-upstream.ts` for M5.5's probe engine (the `security/token.ts`
 * extraction pattern: the CLI module re-exports, so existing importers keep
 * working). Per-area constants rule (`src/policy/constants.ts` precedent).
 */

/**
 * Diagnostic prefix for upstream-level failure lines. Historically
 * `[connect]` — the `connect` command was this layer's first (and remains
 * its primary interactive) consumer, and its stderr assertions pin the
 * string. Other callers (`probe`) supply their own `onDiagnostic` sink and
 * decide what to surface.
 */
export const DIAGNOSTIC_PREFIX = '[connect]'

/**
 * Grace period for a child that was asked to exit (its stdin was closed)
 * before the upstream escalates to SIGTERM/SIGKILL.
 */
export const CHILD_EXIT_GRACE_MS = 5_000
