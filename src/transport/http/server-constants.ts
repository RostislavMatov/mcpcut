/**
 * Constants for the downstream HTTP front (`server.ts`/`routes.ts`/`auth.ts`/
 * `session.ts`/`sse.ts` — M3 Task 10). Kept separate from `constants.ts`
 * (Task 9, upstream client) so the two tasks never edit the same file; both
 * follow the per-area constants rule (`src/policy/constants.ts` precedent).
 *
 * Everything here is transport-mechanical (statuses, limits, timing, fixed
 * error bodies). Nothing may encode JSON-RPC/MCP semantics — CLAUDE.md
 * layering invariant, enforced by `tests/architecture/imports.test.ts`.
 */

/** Fail-safe default bind address (plan decision: Bearer without TLS never leaves the box by default). */
export const DEFAULT_HTTP_HOST = '127.0.0.1'

/**
 * Hostnames considered local for the bind warning AND for the default Origin
 * allowlist (spec matrix §4.2: DNS rebinding targets localhost, so localhost
 * origins are the only ones allowed by default).
 */
export const LOCALHOST_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '::1', '[::1]']

/** Warning printed to stderr when `listen` binds a non-localhost host. */
export const NON_LOCALHOST_BIND_WARNING = '[http] binding to non-localhost host; put TLS in front'

/** Cap on one POST request body; larger → 413 (DoS bound, mirrors MAX_UPSTREAM_RESPONSE_BYTES). */
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024

/** Cap on concurrently open sessionful sessions; creating one past it → 429. */
export const MAX_CONCURRENT_SESSIONS = 64

/** A session untouched for this long is evicted (matrix §1.5: server MAY end a session any time). */
export const SESSION_IDLE_TTL_MS = 5 * 60_000

/** How often the idle sweeper runs (unref'ed timer). */
export const SESSION_SWEEP_INTERVAL_MS = 10_000

/** Interval between `: ping` heartbeat comments on an open GET-SSE stream. */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000

/**
 * Max server-initiated messages buffered per session while no GET stream is
 * open. Past the cap the OLDEST buffered message is dropped: undelivered
 * server-initiated messages are declared lost by decision §4.1 of the spec
 * matrix, and recent ones are the more useful to keep.
 */
export const MAX_BUFFERED_SERVER_MESSAGES = 256

/** URL path segments `/agents/:agent/servers/:server` — same shape as registry/agent names. */
export const ROUTE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export const HTTP_STATUS_OK = 200
export const HTTP_STATUS_NO_CONTENT = 204
export const HTTP_STATUS_BAD_REQUEST = 400
export const HTTP_STATUS_UNAUTHORIZED = 401
export const HTTP_STATUS_FORBIDDEN = 403
export const HTTP_STATUS_CONFLICT = 409
export const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429
export const HTTP_STATUS_INTERNAL_ERROR = 500

/**
 * Fixed response bodies. Deliberately uniform and detail-free:
 * `BODY_UNAUTHORIZED` is byte-identical for a missing header, a malformed
 * header, an unknown token and a revoked agent (no existence oracle), and
 * `BODY_INTERNAL` never carries error internals.
 */
export const BODY_UNAUTHORIZED = Buffer.from('{"error":"unauthorized"}', 'utf8')
export const BODY_FORBIDDEN = Buffer.from('{"error":"forbidden"}', 'utf8')
export const BODY_NOT_FOUND = Buffer.from('{"error":"not-found"}', 'utf8')
export const BODY_SESSION_NOT_FOUND = Buffer.from('{"error":"session-not-found"}', 'utf8')
export const BODY_REQUEST_IN_FLIGHT = Buffer.from('{"error":"request-in-flight"}', 'utf8')
export const BODY_PAYLOAD_TOO_LARGE = Buffer.from('{"error":"payload-too-large"}', 'utf8')
export const BODY_TOO_MANY_SESSIONS = Buffer.from('{"error":"too-many-sessions"}', 'utf8')
export const BODY_INTERNAL = Buffer.from('{"error":"internal"}', 'utf8')
export const BODY_BAD_REQUEST = Buffer.from('{"error":"bad-request"}', 'utf8')
export const BODY_METHOD_NOT_ALLOWED = Buffer.from('{"error":"method-not-allowed"}', 'utf8')
