/**
 * Constants of the server-status probe (M5.5 п.1, решения владельца O1–O8;
 * threat model: ADR-0008). Per-area constants rule
 * (`src/policy/constants.ts` precedent): these are the probe's own and do
 * not belong in `src/config.ts`.
 */

/**
 * Hard deadline for one probe: from the start of the attempt (spawn /
 * connect) to a valid answer to the probe message. A hung spawn must hold
 * neither a page nor a concurrency slot (ADR-0008, компенсирующие меры).
 * Owner-approved value (2026-08-24); revisited after the smoke run.
 */
export const PROBE_TIMEOUT_MS = 10_000

/** Max probes in flight at once — the fan-out cap of ADR-0008 (one `/servers` view of N stale servers must not mean N simultaneous spawns). */
export const PROBE_MAX_CONCURRENT = 4

/**
 * Silence threshold (~1h): while the journal shows successful traffic newer
 * than this, the status is derived passively and no probe runs; older —
 * a status read may trigger a lazy probe (O1/O2). Doubles as the staleness
 * horizon of a stored probe result.
 */
export const STATUS_STALE_AFTER_MS = 3_600_000

/**
 * "Recent activity" window (5 min) for the blinking-dot indicator on
 * `/servers`: alive + traffic newer than this blinks. Deliberately much
 * smaller than `STATUS_STALE_AFTER_MS`; adjusted by smoke feedback.
 */
export const ACTIVITY_BLINK_WINDOW_MS = 300_000

/**
 * The reserved `sessionId` probe journal records are written under. Chosen
 * so probe records are separable from agent traffic BY CONSTRUCTION:
 *
 *  - matches `SESSION_ID_PATTERN` (`src/config.ts`) — a legal session id;
 *  - can never equal a registry server name: the underscore is legal in a
 *    session id but rejected by `REGISTRY_SERVER_NAME_PATTERN`
 *    (`src/registry/constants.ts`), so no registrable server can collide
 *    with it (the plan's `plane-probe` spelling WOULD have been a valid
 *    server name — hence the underscore).
 *
 * Both properties are pinned by tests in `tests/probe/engine.test.ts`.
 */
export const PROBE_SESSION_ID = 'plane_probe'
