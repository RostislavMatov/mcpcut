/**
 * How long one create may take, end to end (plan `tenant-orchestrator`,
 * security review LOW-1; readiness numbers revised after the live smoke on
 * S2, 2026-09-27 — see `tenant-exec.ts` for why the readiness check itself
 * changed). A leaf module with no imports, shared by the provisioner (its own
 * waits) and the hub's HTTP client (how long it waits for the provisioner),
 * so the budget reads in one place:
 *
 *   readiness 60 s + `admin add` 30 s + Docker steps ≥ 30 s  <  hub 150 s  <  socket 180 s
 *
 * The hub's client must outlast the provisioner's waits and the Docker calls
 * around them (network, volume, container, start, Caddy, and a rollback), or
 * the hub gives up on a create that is about to succeed. The provisioner's
 * idle socket must outlast the client, so the client's timeout is the one
 * that fires and the hub reports it. Create runs in the background now (`hub`
 * phase 4), so Cloudflare's 100 s edge timeout no longer bounds this budget.
 */

/** The readiness probe (`node -e`, `tenant-exec.ts`) polling until both services answer. */
export const READY_TIMEOUT_MS = 60_000
/** One readiness-probe exec. */
export const READY_EXEC_TIMEOUT_MS = 5_000
/** One `admin add|rotate --json` exec. */
export const ADMIN_EXEC_TIMEOUT_MS = 30_000
/** Room left for the Docker steps around the two waits. */
export const CREATE_DOCKER_MARGIN_MS = 30_000
/** How long the hub waits for a create's answer. */
export const CREATE_TIMEOUT_MS = 150_000
/** The provisioner's idle-socket bound: longer than the hub waits. */
export const PROVISIONER_SOCKET_TIMEOUT_MS = 180_000
