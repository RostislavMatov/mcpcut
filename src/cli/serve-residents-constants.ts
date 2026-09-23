/**
 * Mechanics of the resident supervisor (ADR-0016): how many servers start at
 * once, how a crashing one is retried, when the supervisor gives up. What the
 * pool promises an agent (budgets, caps) lives in `src/pool/constants.ts`;
 * these numbers are about processes, and nothing outside `serve` reads them.
 */

/**
 * Starts running at once, across the service (owner decision D1+, "no more
 * than 2"). Four `npx -y` installs on a 2-CPU host took ~14 s in the phase-5
 * smoke; two at a time is what such a host carries without starving the
 * plane itself.
 */
export const POOL_RESIDENT_START_CONCURRENCY = 2

/** First pause before restarting a resident that ended on its own (RS6). */
export const POOL_RESIDENT_RESTART_BASE_MS = 1000

/** Longest pause between restarts: 1, 2, 4 … never more than a minute (RS6). */
export const POOL_RESIDENT_RESTART_MAX_MS = 60_000

/**
 * Failed starts in a row after which the supervisor stops trying (RS6), until
 * the record or the grant changes or `serve` restarts. Without a limit a
 * command that dies at start would spin forever, a minute apart.
 */
export const POOL_RESIDENT_MAX_CONSECUTIVE_FAILURES = 5

/**
 * Requests the plane's own negotiation with one starting server may have in
 * flight: the handshake and its `server/discover` fallback, with room to spare.
 */
export const POOL_RESIDENT_NEGOTIATION_PENDING = 16
