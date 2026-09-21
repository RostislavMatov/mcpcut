/**
 * Constants of the `connect --url` bridge (ADR-0015). Per-area constants
 * rule (`src/policy/constants.ts` precedent): these are the bridge's own and
 * do not belong in `src/config.ts` — which the bridge deliberately does not
 * read, because it runs on a machine that has no install at all.
 */

/**
 * The agent pool endpoint an address WITHOUT a path means (owner decision
 * PE5): the operator is handed a base — `https://plane.example:8090` — and
 * the path stays an internal detail nobody types. Until the pool endpoint
 * exists (PRD phase 3) this address honestly answers 404, and
 * `noEndpointMessage` says so in as many words.
 */
export const BRIDGE_POOL_PATH = '/mcp'

/**
 * The JSON-RPC error code the bridge answers a request with when it could
 * not deliver it at all. Sits alongside the proxy's own reserved codes
 * (`proxy/synthesize.ts`: -32001 policy, -32002 approval, -32003
 * quarantine); -32004 means "the transport under this bridge failed", which
 * is a different thing from any decision the plane made.
 */
export const ERROR_CODE_BRIDGE_TRANSPORT = -32004

/**
 * Exit code for a bridge whose session the service will not continue — an
 * expired session, or an SSE stream that did not come back within its
 * reconnect budget. Distinct from `EXIT_CODE_REFUSED` (1) on purpose: 1
 * means "do not bother retrying, something is wrong with how you asked",
 * this means "the bridge is gone, start a new one" — which is exactly what
 * an MCP client does when its server process exits.
 */
export const EXIT_CODE_BRIDGE_LOST = 4
