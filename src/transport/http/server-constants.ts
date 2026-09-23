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
 * origins are the only ones allowed by default). Re-exported from
 * `src/net/origin-host.ts` — the single source of the list — so the screening
 * side and the transport side can never drift apart (M4 review fix; the
 * import direction transport → net is already established by `server.ts`).
 */
export { LOCALHOST_HOSTNAMES } from '../../net/origin-host.js'

/** Warning printed to stderr when `listen` binds a non-localhost host. */
export const NON_LOCALHOST_BIND_WARNING = '[http] binding to non-localhost host; put TLS in front'

/**
 * Additional warning for a WILDCARD bind (`0.0.0.0`, `::`): the bind address
 * is not a meaningful Host value, so Host screening admits only localhost
 * names and explicit allowlist entries — without `--allowed-host`, every
 * remote client is answered 403 no matter what token it carries.
 */
export const WILDCARD_BIND_WARNING =
  '[http] wildcard bind: Host screening admits only localhost names and explicit ' +
  'allowlist entries; remote clients will get 403 unless --allowed-host names them'

/** Cap on one POST request body; larger → 413 (DoS bound, mirrors MAX_UPSTREAM_RESPONSE_BYTES). */
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024

/**
 * Explicit per-connection timeouts for the listener (security audit
 * 2026-09-02, F3). Node's own defaults (60 s headers / 300 s request / 5 s
 * keep-alive) were never a choice this front made; these are, and a test
 * pins them.
 *
 * What `requestTimeout` covers, per Node's `http.Server` semantics: the time
 * from a request's first byte until its whole message (headers + body) has
 * been RECEIVED. The parser's clock stops at message-complete, so the
 * response side is not on it — a GET-SSE stream, or a POST whose answer waits
 * on a human approval for up to `STATELESS_RESPONSE_TIMEOUT_MS`, is never cut
 * by this timer (verified empirically on Node 25.6, floor 24: an SSE response
 * outlived a 200 ms `requestTimeout` untouched). An MCP request body is one
 * JSON-RPC message under `MAX_REQUEST_BODY_BYTES`, so 60 s to deliver it is
 * generous for a real agent and a ceiling for a trickling one.
 *
 * `headersTimeout` must stay ≤ `requestTimeout`: Node checks the pair only
 * when both arrive as `createServer` options, not on property assignment, so
 * `net/connection-timeouts.ts` guards it at startup and a test pins the
 * ordering. The keep-alive value is Node's default made explicit — it governs
 * an IDLE keep-alive socket between requests only, never one with a response
 * in flight.
 */
export const HEADERS_TIMEOUT_MS = 30_000
export const REQUEST_TIMEOUT_MS = 60_000
export const KEEP_ALIVE_TIMEOUT_MS = 5_000

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
 * Path of the agent pool endpoint (PE5). The operator is handed a base
 * address and never types this; `connect --url` appends it on their behalf,
 * so it must equal `BRIDGE_POOL_PATH` — a test pins the pair.
 */
export const POOL_ROUTE_PATH = '/mcp'

/**
 * The opaque `serverName` a pool session carries in its `SessionContext`.
 * A leading `_` is unrepresentable in `ROUTE_NAME_PATTERN`, so this can never
 * collide with a registry server name — the same construction that keeps
 * `plane_probe` out of the server namespace (`src/probe/constants.ts`).
 */
export const POOL_ROUTE_TARGET = '_pool'

/**
 * Requests one session may hold in flight at once WHEN it declares response
 * correlation. A pool session fans one agent's calls out to several
 * upstreams, and a `tools/call` waiting on a human approval holds its slot
 * for minutes; without a cap, an agent could open as many waits as it can
 * write POSTs. Sessions that declare no correlation keep the older, stricter
 * rule of exactly one (409).
 */
export const MAX_CORRELATED_IN_FLIGHT = 64

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
 * 429 body for a correlating session holding `MAX_CORRELATED_IN_FLIGHT`
 * requests already. Distinct from `BODY_TOO_MANY_SESSIONS`: the agent has
 * not run out of sessions, it has run out of room in the one it holds, and
 * the remedy is to wait for an answer rather than to open another session.
 */
export const BODY_TOO_MANY_REQUESTS_IN_FLIGHT = Buffer.from(
  '{"error":"too-many-requests-in-flight"}',
  'utf8',
)
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
