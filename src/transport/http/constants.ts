/**
 * Constants for the HTTP transport (`src/transport/http/*`). Kept in their
 * own file per the per-area constants rule (`src/policy/constants.ts`,
 * `src/registry/constants.ts`): `src/config.ts` is not a dumping ground.
 *
 * Everything here is transport-mechanical (header names, statuses, timing).
 * Nothing in this module may encode JSON-RPC/MCP semantics — see the
 * layering invariant in CLAUDE.md and `tests/architecture/imports.test.ts`.
 */

/**
 * Session header minted by sessionful servers (spec ≤ 2025-11-25). Written
 * `Mcp-Session-Id` in 2025-06-18 and `MCP-Session-Id` in 2025-11-25; HTTP
 * header names are case-insensitive and Node lowercases incoming header
 * names, so the constant is the lowercase form. The header VALUE is kept
 * exactly as the server sent it (`docs/research/http-spec-matrix.md` §1.5).
 */
export const MCP_SESSION_ID_HEADER = 'mcp-session-id'

/** Protocol-version header (2025-06-18+). Value is pass-through (ADR-0002). */
export const MCP_PROTOCOL_VERSION_HEADER = 'mcp-protocol-version'

/** JSON bodies on POST requests and plain JSON responses. */
export const CONTENT_TYPE_JSON = 'application/json'

/** SSE responses (POST answer stream or the GET server-initiated stream). */
export const CONTENT_TYPE_SSE = 'text/event-stream'

/** Accept header the spec requires on every POST (matrix §1.2 / §2.2). */
export const ACCEPT_JSON_AND_SSE = 'application/json, text/event-stream'

/** Accept header for the GET server-initiated stream (matrix §1.3). */
export const ACCEPT_SSE_ONLY = 'text/event-stream'

/** 202: server accepted a body that produces no response (notification). */
export const HTTP_STATUS_ACCEPTED = 202

/** 404 while a session id is active: the session expired (matrix §1.5). */
export const HTTP_STATUS_NOT_FOUND = 404

/** 405 on GET/DELETE: the server does not offer that endpoint — valid. */
export const HTTP_STATUS_METHOD_NOT_ALLOWED = 405

/** First delay before reconnecting a broken GET-SSE stream. */
export const SSE_RECONNECT_BASE_DELAY_MS = 250

/** Upper bound for the exponential reconnect backoff. */
export const SSE_RECONNECT_MAX_DELAY_MS = 8_000

/** Consecutive failed reconnects tolerated before the stream is given up. */
export const SSE_RECONNECT_MAX_ATTEMPTS = 5

/** How long `close()` waits for in-flight POSTs before proceeding. */
export const CLOSE_DRAIN_TIMEOUT_MS = 2_000

/**
 * Cap on a buffered JSON response body and on one SSE event's buffered
 * text. Prevents an upstream from ballooning proxy memory; generous next
 * to real MCP payloads.
 */
export const MAX_UPSTREAM_RESPONSE_BYTES = 8 * 1024 * 1024

/**
 * Upper bound honored for a server-sent SSE `retry:` directive. The client
 * MUST honor `retry:` as a reconnect-delay floor (sessionful spec, Δ
 * 2025-11-25), but a hostile upstream sending e.g. `retry: 4294967295`
 * must not be able to stall reconnection for (effectively) ever.
 */
export const SSE_RETRY_MAX_DELAY_MS = 60_000
