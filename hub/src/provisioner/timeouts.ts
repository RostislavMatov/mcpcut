/**
 * How long one create may take, end to end (plan `tenant-orchestrator`,
 * security review LOW-1). A leaf module with no imports, shared by the
 * provisioner (its own waits) and the hub's HTTP client (how long it waits
 * for the provisioner), so the budget reads in one place:
 *
 *   readiness 45 s + `admin add` 20 s + Docker steps ≥ 30 s  <  hub 120 s  <  socket 150 s
 *
 * The hub's client must outlast the provisioner's waits and the Docker calls
 * around them (network, volume, container, start, Caddy, and a rollback), or
 * the hub gives up on a create that is about to succeed. The provisioner's
 * idle socket must outlast the client, so the client's timeout is the one
 * that fires and the hub reports it.
 */

/** `status --json` polling until both services answer. */
export const READY_TIMEOUT_MS = 45_000
/** One `admin add|rotate --json` exec. */
export const ADMIN_EXEC_TIMEOUT_MS = 20_000
/** Room left for the Docker steps around the two waits. */
export const CREATE_DOCKER_MARGIN_MS = 30_000
/** How long the hub waits for a create's answer. */
export const CREATE_TIMEOUT_MS = 120_000
/** The provisioner's idle-socket bound: longer than the hub waits. */
export const PROVISIONER_SOCKET_TIMEOUT_MS = 150_000
