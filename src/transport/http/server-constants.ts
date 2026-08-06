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

/**
 * Cap on concurrently open sessions — sessionful ones AND stateless
 * one-shots still in flight; creating one past it → 429. Both models cost
 * an upstream (a spawned child or an open client), so both are counted:
 * a cap only sessionful traffic respected would be no cap at all.
 */
export const MAX_CONCURRENT_SESSIONS = 64

/** A session untouched for this long is evicted (matrix §1.5: server MAY end a session any time). */
export const SESSION_IDLE_TTL_MS = 5 * 60_000

/**
 * How long a stateless POST waits for the single message it is owed before
 * answering 504. Equal to `SESSION_IDLE_TTL_MS` on purpose: a stateless
 * one-shot session is exactly a session whose whole life is that one
 * request, so "how long may a session be idle" and "how long may this
 * request wait" are the same question. Without it a silent (or dead)
 * upstream would hold the socket, the journal sink and the child process
 * forever — the one-shot session is not in the sessions map, so neither
 * the idle sweeper nor `close()` used to reach it.
 */
export const STATELESS_RESPONSE_TIMEOUT_MS = SESSION_IDLE_TTL_MS

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

/**
 * Total bytes those buffered messages may occupy. The count cap alone is a
 * memory promise the process cannot keep: 256 messages of up to
 * `MAX_REQUEST_BODY_BYTES` each is 2 GiB per session. Whichever cap binds
 * first evicts the oldest messages, by the same §4.1 reasoning.
 */
export const MAX_BUFFERED_SERVER_BYTES = 8 * 1024 * 1024

/** URL path segments `/agents/:agent/servers/:server` — same shape as registry/agent names. */
export const ROUTE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Shape a session-factory refusal code must have to reach an agent
 * verbatim. A factory may return an explanatory refusal ("protocol-
 * mismatch: server X is registered as ..."); only the leading code token
 * is echoed, and only if it looks like one — the prose belongs on the
 * plane's stderr, because it describes the plane's own configuration.
 */
export const REFUSAL_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export const HTTP_STATUS_OK = 200
export const HTTP_STATUS_NO_CONTENT = 204
export const HTTP_STATUS_BAD_REQUEST = 400
export const HTTP_STATUS_UNAUTHORIZED = 401
export const HTTP_STATUS_FORBIDDEN = 403
export const HTTP_STATUS_CONFLICT = 409
export const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429
export const HTTP_STATUS_INTERNAL_ERROR = 500
export const HTTP_STATUS_GATEWAY_TIMEOUT = 504

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
/**
 * 504 body: the request was abandoned without an answer — the upstream
 * stayed silent past `STATELESS_RESPONSE_TIMEOUT_MS`, or the agent's own
 * socket went away first. Deliberately one code for both: the agent learns
 * "no answer is coming", never which of the plane's timers fired.
 */
export const BODY_UPSTREAM_TIMEOUT = Buffer.from('{"error":"upstream-timeout"}', 'utf8')
export const BODY_INTERNAL = Buffer.from('{"error":"internal"}', 'utf8')
export const BODY_BAD_REQUEST = Buffer.from('{"error":"bad-request"}', 'utf8')
export const BODY_METHOD_NOT_ALLOWED = Buffer.from('{"error":"method-not-allowed"}', 'utf8')
