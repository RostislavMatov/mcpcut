/**
 * Limits and literals of the agent pool multiplexer (`src/pool/*`, ADR-0015).
 * Kept out of `src/config.ts` per the M2 convention: each area owns its own
 * `constants.ts` instead of sharing a dumping ground.
 *
 * Nothing here is a spec literal — MCP method names and protocol versions live
 * in `src/protocol/mcp.ts`, the single point of coupling to the spec.
 */

/**
 * Separator between the server name and the tool/prompt name in a pool-side
 * name. `__` is what Claude Code, MetaMCP and Docker MCP Gateway already use;
 * a dot was rejected because Anthropic's and OpenAI's name patterns refuse it.
 * Registry server names are `[a-z0-9][a-z0-9-]{0,63}` and contain no `_`, so
 * splitting at the FIRST occurrence is unambiguous even when the tool's own
 * name contains `__` (ADR-0015 §2).
 */
export const POOL_NAME_SEPARATOR = '__'

/**
 * Above this length a pool name is hidden from the merged list (PE2 a). 64 is
 * OpenAI's function-name limit; one invalid name breaks the agent's whole
 * request, so the cost of silently hiding is lower than the cost of refusing.
 * A hidden tool stays reachable through its per-server address (PE4).
 */
export const POOL_NAME_HIDE_ABOVE_CHARS = 64

/**
 * Above this length a pool name is listed but flagged to the operator: Cursor
 * allows 60 for "server + tool", and Claude Code prepends its own 13-character
 * `mcp__mcpcut__` on top of whatever the plane produced.
 */
export const POOL_NAME_WARN_ABOVE_CHARS = 47

/** `serverInfo.name` the plane reports for itself at a pool address (PE12). */
export const POOL_SERVER_INFO_NAME = 'mcpcut'

/** `clientInfo.name` the plane presents when it opens its own upstream session. */
export const POOL_UPSTREAM_CLIENT_NAME = 'mcpcut-pool'

/**
 * Hard cap on requests the correlator tracks at once. Same value and same
 * rationale as the journal's `MAX_PENDING_REQUESTS` (`src/config.ts`), but the
 * pool's cap is fail-CLOSED rather than evicting: a forgotten id would mean a
 * response with nowhere to go, which is "one outcome per id" broken.
 */
export const MAX_POOL_PENDING_REQUESTS = 10_000

/**
 * Prefix of ids the plane mints for its OWN upstream requests (fan-out
 * `tools/list`, `initialize`). Reserved: a client id starting with it is
 * refused rather than tracked, so the two id spaces can never collide and a
 * plane-originated response can never be forwarded to the agent (ADR-0015 §3).
 */
export const POOL_FANOUT_ID_PREFIX = 'mcpcut-pool:'

/**
 * Bounds on what one merge may build. Node is single-threaded, so a catalog
 * assembled and `JSON.stringify`ed without a limit lets ONE upstream stall
 * every other agent's session in the process — which is why these are caps on
 * a single response, not rate limits (those are phase 3).
 *
 * Per-server count matches `MAX_QUARANTINED_TOOLS_PER_SERVER`: a server whose
 * catalog outgrows what the inventory will hold is already past what this
 * product supports.
 */
export const MAX_POOL_ENTRIES_PER_SERVER = 2000

/** One entry past this size is not a tool description; it is a payload. */
export const MAX_POOL_ENTRY_BYTES = 64 * 1024

/** Ceiling on the whole merged line, whatever the parts add up to. */
export const MAX_POOL_CATALOG_BYTES = 8 * 1024 * 1024

/** JSON-RPC "Invalid params": the spec's own code for an unknown tool name. */
export const ERROR_CODE_UNKNOWN_POOL_TARGET = -32602

/** Upper bound on the name echoed back in an unknown-target error message. */
export const MAX_ERROR_NAME_CHARS = 128
