/**
 * Constants for the admin UI HTTP core (`src/ui/*`, M4 Task 9). Per the
 * per-area convention, the UI owns its own `constants.ts` rather than reaching
 * into `src/transport/http/server-constants.ts`: the layering rule forbids
 * `src/ui/**` from importing the transport layer at all (ADR-0004, §6), so
 * statuses, bodies and limits are declared here even where they numerically
 * match the agent front.
 */

/** Default UI bind address (ADR-0004: loopback by default, TLS terminated outside). */
export const DEFAULT_UI_HOST = '127.0.0.1'

/** Default UI port. */
export const DEFAULT_UI_PORT = 8091

/** Cap on one request body; larger → 413 (DoS bound). Forms and actions are tiny. */
export const MAX_UI_BODY_BYTES = 1 * 1024 * 1024

// --- Sessions -------------------------------------------------------------

/** Name of the session cookie. */
export const SESSION_COOKIE_NAME = 'mcp_admin_session'

/** Random bytes in a session id (base64url-encoded). 256 bits, unguessable. */
export const SESSION_ID_RANDOM_BYTES = 32

/** Random bytes in a per-session CSRF token. */
export const CSRF_TOKEN_RANDOM_BYTES = 32

/** Header a state-changing request carries its CSRF token in. */
export const CSRF_HEADER_NAME = 'x-csrf-token'

/**
 * Form field a state-changing request may carry its CSRF token in (fallback for
 * a real `<form>` POST). MUST match the hidden field name documented in
 * `assets/app-js.ts` and embedded by Wave-3 pages — kept as `csrf_token`.
 */
export const CSRF_FIELD_NAME = 'csrf_token'

/**
 * Absolute session lifetime. A session older than this is invalid regardless
 * of activity — a stolen cookie has a bounded window, and the value is
 * deterministic for tests (injected clock). Sessions live only in process
 * memory (ADR-0004), so this is also the maximum a restart-free process holds
 * one open.
 */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000

/** Max concurrent in-memory sessions; the oldest is evicted past the cap. */
export const MAX_SESSIONS = 64

// --- Server-Sent Events (SSE) ---------------------------------------------

/**
 * Heartbeat cadence for open `GET /events` streams: a comment line emitted this
 * often keeps intermediaries (and the browser) from idling the connection out.
 */
export const UI_SSE_HEARTBEAT_INTERVAL_MS = 15_000

/**
 * Hard cap on concurrent SSE subscribers per `ui` process; a subscribe past it
 * is refused with 503 + Retry-After so a client reconnects once a slot frees.
 * Kept named-distinct from `MAX_SESSIONS` even where the value coincides — the
 * two caps bound unrelated resources and may diverge without notice.
 */
export const UI_MAX_SSE_SUBSCRIBERS = 64

/**
 * The single SSE response-header set, written once by `server.ts` on the stream
 * path together with `securityHeaders()`. `x-accel-buffering: no` defeats
 * reverse-proxy buffering that would otherwise hold events; `no-store,
 * no-transform` keeps the stream uncached and untouched by intermediaries.
 * The hub never writes these — there is exactly one owner of the SSE headers.
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
})

// --- Watcher --------------------------------------------------------------

/** Poll cadence for the approvals/quarantine watcher (`watch.ts`). */
export const UI_QUEUE_POLL_INTERVAL_MS = 1000

// --- Login rate limiting --------------------------------------------------

/** Failed logins tolerated within the window before `/login` answers 429. */
export const LOGIN_MAX_FAILURES = 5

/** Sliding window over which failed logins are counted. */
export const LOGIN_RATE_WINDOW_MS = 60_000

/** Emitted to the warn sink when the login rate limit trips. */
export const LOGIN_RATE_LIMIT_WARNING = '[ui] login rate limit exceeded; refusing further attempts'

// --- HTTP statuses --------------------------------------------------------

export const HTTP_STATUS_OK = 200
export const HTTP_STATUS_FOUND = 302
export const HTTP_STATUS_BAD_REQUEST = 400
export const HTTP_STATUS_UNAUTHORIZED = 401
export const HTTP_STATUS_FORBIDDEN = 403
export const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429
export const HTTP_STATUS_INTERNAL_ERROR = 500
export const HTTP_STATUS_NOT_IMPLEMENTED = 501

// --- Fixed response bodies (uniform, detail-free; no existence oracle) -----

export const CONTENT_TYPE_JSON = 'application/json; charset=utf-8'
export const CONTENT_TYPE_HTML = 'text/html; charset=utf-8'

/** Byte-identical for a missing, malformed, unknown or revoked credential. */
export const BODY_UNAUTHORIZED = Buffer.from('{"error":"unauthorized"}', 'utf8')
export const BODY_FORBIDDEN = Buffer.from('{"error":"forbidden"}', 'utf8')
export const BODY_TOO_MANY_REQUESTS = Buffer.from('{"error":"too-many-requests"}', 'utf8')
export const BODY_PAYLOAD_TOO_LARGE = Buffer.from('{"error":"payload-too-large"}', 'utf8')
export const BODY_INTERNAL = Buffer.from('{"error":"internal"}', 'utf8')
export const BODY_NOT_IMPLEMENTED = Buffer.from('{"error":"not-implemented"}', 'utf8')

// --- Security headers (ADR-0004 model of threats) -------------------------

/**
 * The exact Content-Security-Policy the UI serves on every response. `'none'`
 * default with an explicit self allowlist per directive; no inline scripts
 * (the ~150 lines of vanilla JS are served as an external `'self'` asset);
 * `frame-ancestors 'none'` defeats clickjacking; `base-uri 'none'` blocks base
 * tag injection.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

/** Warning printed to stderr when the UI binds a non-localhost host. */
export const NON_LOCALHOST_BIND_WARNING =
  '[ui] binding to non-localhost host; terminate TLS in front and restrict access'

/** Additional warning for a wildcard UI bind. */
export const WILDCARD_BIND_WARNING =
  '[ui] wildcard bind: Host screening admits only localhost names and explicit ' +
  'allowlist entries; remote clients will get 403 unless --allowed-host names them'
