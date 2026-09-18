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

/**
 * Explicit per-connection timeouts for the UI listener (security audit
 * 2026-09-02, LOW-2). Node's defaults (60 s headers / 300 s request / 5 s
 * keep-alive) already bound a slow client, but they were never values this
 * console chose: 300 s to finish sending a form under `MAX_UI_BODY_BYTES` is
 * headroom only a socket-holding attacker would use.
 *
 * `requestTimeout` clocks RECEIVING the request (headers + body) and stops at
 * message-complete, so `GET /events` — a response that stays open for hours —
 * is not on it (verified empirically on Node 25.6, floor 24: an SSE response
 * outlived a 200 ms `requestTimeout` untouched). `headersTimeout` must stay ≤
 * `requestTimeout` — guarded at startup by `net/connection-timeouts.ts` and
 * pinned by a test, since Node checks the pair only for constructor options;
 * the keep-alive value is Node's default made explicit and applies to an idle
 * socket between requests only.
 */
export const UI_HEADERS_TIMEOUT_MS = 30_000
export const UI_REQUEST_TIMEOUT_MS = 60_000
export const UI_KEEP_ALIVE_TIMEOUT_MS = 5_000

// --- Sessions -------------------------------------------------------------

/** Name of the session cookie when the UI is reached over plain HTTP (loopback). */
export const SESSION_COOKIE_NAME = 'mcp_admin_session'

/**
 * Name of the session cookie behind TLS. The `__Host-` prefix is enforced by
 * the browser rather than by us: it may only be set from a secure origin, must
 * be `Path=/` with no `Domain`, and therefore cannot be overwritten by a
 * sibling subdomain — which is the session-fixation path an unprefixed cookie
 * on a shared parent domain leaves open. The prefix cannot be used without
 * `Secure`, so the name has to follow the mode.
 */
export const SESSION_COOKIE_NAME_SECURE = `__Host-${SESSION_COOKIE_NAME}`

/**
 * `Strict-Transport-Security`, sent only with `--behind-tls`. Over plain
 * loopback HTTP it would be inert; worse, if the UI is ever reached by a name
 * shared with other services, it would pin that whole name to HTTPS for a year
 * from a listener that does not serve it.
 */
export const STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains'

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

/**
 * Max concurrent in-memory sessions across all admins. Past the cap a login is
 * REFUSED (429); a live session is never evicted to make room, because evicting
 * one would hand any valid low-privilege token a way to sign every owner out.
 * Expired sessions are reaped before the cap is tested.
 */
export const MAX_SESSIONS = 64

/**
 * Max concurrent sessions for ONE admin. Bounds a single account's share of the
 * global cap (a few browsers/tabs per person is generous), so one admin
 * re-logging in a loop cannot consume every slot.
 */
export const SESSIONS_PER_ADMIN_MAX = 8

/**
 * Slots at the top of the pool that only an `owner` login may take. The manual
 * M4 smoke reproduced the bug this closes: eight `viewer` sessions filled the
 * pool and the owner could not log in until the 8-hour TTL expired. Refusing to
 * evict a live session is the right call (see `MAX_SESSIONS`), so the fix is to
 * keep a landing strip rather than to start evicting.
 *
 * Sized to one admin's full per-admin allowance, so the reserve is enough for
 * an owner to actually work, not merely to peek.
 */
export const SESSION_OWNER_RESERVED_SLOTS = 8

/**
 * The reserve is additionally capped at `maxSessions / this` — a small pool
 * (tests, or a deliberately tiny deployment) degrades to the pre-reserve
 * behaviour instead of becoming an owner-only plane. At the default pool of 64
 * the two rules agree exactly on 8.
 */
export const SESSION_OWNER_RESERVE_POOL_DIVISOR = 8

/**
 * Inactivity after which a session is dead regardless of its absolute TTL.
 * Without it a browser tab left open on a laptop lid holds its slot (and its
 * share of the per-admin cap) for the full 8 hours, which is how a handful of
 * forgotten tabs turns into a login refusal for everyone else.
 *
 * Only real requests count as activity: the SSE heartbeat's liveness probe
 * deliberately does not refresh the window, or one forgotten tab with an open
 * stream would defeat the timeout entirely.
 */
export const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000

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
 * Cap on the streams ONE admin may hold. Without it a single admin's tabs (or a
 * reconnect loop) can occupy all 64 slots and every other admin falls back to
 * polling. Matches the per-admin session cap: a stream per session is the shape
 * the UI actually opens.
 */
export const UI_MAX_SSE_SUBSCRIBERS_PER_ADMIN = 8

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

/**
 * How often open SSE streams are re-checked against the live admin store.
 *
 * Separate from the heartbeat on purpose. `admin remove`/`rotate`/`role` run in
 * the CLI — a DIFFERENT process — so the `ui` process learns about a revocation
 * only by re-reading the store. Requests were always refused immediately (each
 * one re-validates), but a never-ending SSE stream has no next request, and
 * riding the 15s heartbeat made the revocation SLA 15s.
 *
 * There is no cross-process notification to subscribe to: the state lives in
 * SQLite (M4.5), and a filesystem watch on the database would fire on every
 * unrelated write while still missing nothing useful. Polling is the honest
 * mechanism; the cost is one deduplicated read per distinct session per tick.
 */
export const UI_SESSION_SWEEP_INTERVAL_MS = 2000

// --- Watcher --------------------------------------------------------------

/** Poll cadence for the approvals/quarantine watcher (`watch.ts`). */
export const UI_QUEUE_POLL_INTERVAL_MS = 1000

/**
 * How many bounded change pages one poll tick will drain before yielding.
 *
 * The drain loop terminates on its own (each page strictly advances the
 * watermark), but an authenticated agent enqueueing in a tight loop could keep
 * it producing pages and hold one tick for an unbounded stretch of wall clock.
 * Capping the pages hands control back to the event loop; the remainder is
 * picked up on the next tick, because the watermark has already advanced.
 */
export const UI_QUEUE_DRAIN_MAX_PAGES = 20

// --- Login rate limiting --------------------------------------------------

/**
 * Failed logins tolerated from ONE client address within the window before
 * `/login` answers 429 to that address. Keyed rather than global: an unkeyed
 * counter lets one wrong-guessing client lock out every other admin.
 *
 * `login-flow.ts` counts an attempt against this window the moment it is
 * admitted, before the token is looked up, and a successful login then clears
 * the whole window. So the number bounds failures within the window PLUS the
 * attempts from that address still in flight — the only ordering in which
 * concurrent attempts cannot all pass a window none of them has touched yet.
 */
export const LOGIN_MAX_FAILURES = 5

/**
 * Login attempts tolerated across ALL addresses within the window — the
 * backstop against a distributed flood that never trips a per-address window.
 * Set well above `LOGIN_MAX_FAILURES` so ordinary mistyping never reaches it.
 *
 * Attempts, not failures: an attempt is counted when it is admitted (see
 * `LOGIN_MAX_FAILURES`), and the per-address forgiveness on success does not
 * reach the global window. A hundred SUCCESSFUL logins a minute therefore trips
 * this too — which on a plane holding 8-hour sessions means a flood, and which
 * costs the admins who caused it a one-second pause, nothing more.
 *
 * Past it attempts are DELAYED, never refused: a refusal here is keyed on
 * nothing, so any process that can reach `/login` (127.0.0.0/8 aliases are
 * plenty) could spend 100 wrong guesses and lock every admin out. A delay costs
 * an attacker the same throughput without ever denying a legitimate login.
 */
export const LOGIN_GLOBAL_MAX_FAILURES = 100

/**
 * Delay added to each login attempt while the global ceiling is exceeded. Long
 * enough to flatten a flood's throughput, short enough that a human logging in
 * during one notices a pause rather than an outage.
 */
export const LOGIN_GLOBAL_PENALTY_DELAY_MS = 1000

/**
 * How many login attempts may be sitting in the penalty delay at once.
 *
 * The delay throttles a flood without denying anyone — but a held request is a
 * held socket, and nothing else in the process bounds how many can pile up
 * while the ceiling is tripped. Past this cap an attempt is served WITHOUT the
 * delay, which is exactly the pre-penalty behaviour: the throttle degrades, the
 * login never does. Refusing here instead would put back the unkeyed lockout
 * the delay exists to remove.
 */
export const LOGIN_MAX_CONCURRENT_PENALTIES = 32

/**
 * Cap on tracked client addresses. Bounds the limiter's memory against a
 * spoofed-source flood; past it the least-recently-seen address is forgotten,
 * which at worst forgives one client's history and never locks anyone out.
 */
export const LOGIN_RATE_LIMIT_MAX_KEYS = 1024

/** Sliding window over which failed logins are counted. */
export const LOGIN_RATE_WINDOW_MS = 60_000

/** Emitted to the warn sink when the login rate limit trips. */
export const LOGIN_RATE_LIMIT_WARNING = '[ui] login rate limit exceeded; refusing further attempts'

/** Emitted while the global ceiling is exceeded and attempts are being delayed. */
export const LOGIN_GLOBAL_PENALTY_WARNING =
  '[ui] global login failure ceiling exceeded; delaying attempts (not refusing them)'

/** Emitted when a login is refused because a session cap is already met. */
export const SESSION_CAPACITY_WARNING =
  '[ui] session capacity reached; refusing the login rather than evicting a live session'

/**
 * Where a successful `POST /login` sends the browser. A 303 to a page (not a
 * JSON body) is what makes the plain, script-free HTML form usable; the CSRF
 * token travels in the destination page's `<meta name="csrf-token">`, never in
 * this URL.
 */
export const POST_LOGIN_LOCATION = '/'

// --- HTTP statuses --------------------------------------------------------

/**
 * Every status the UI can answer with, declared once. Handlers import from
 * here rather than redeclaring their own locals: three parallel naming schemes
 * across seven files is how `303` ends up meaning something different in two of
 * them.
 */
export const HTTP_STATUS_OK = 200
export const HTTP_STATUS_FOUND = 302
export const HTTP_STATUS_SEE_OTHER = 303
export const HTTP_STATUS_NOT_MODIFIED = 304
export const HTTP_STATUS_BAD_REQUEST = 400
export const HTTP_STATUS_UNAUTHORIZED = 401
export const HTTP_STATUS_FORBIDDEN = 403
export const HTTP_STATUS_NOT_FOUND = 404
export const HTTP_STATUS_CONFLICT = 409
export const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429
export const HTTP_STATUS_INTERNAL_ERROR = 500
export const HTTP_STATUS_NOT_IMPLEMENTED = 501
export const HTTP_STATUS_SERVICE_UNAVAILABLE = 503

// --- Fixed response bodies (uniform, detail-free; no existence oracle) -----

export const CONTENT_TYPE_JSON = 'application/json; charset=utf-8'
export const CONTENT_TYPE_HTML = 'text/html; charset=utf-8'

/**
 * The media type looked for in an `Accept` header to tell a browser navigation
 * from a script or an API client (`login-flow.ts`). Derived from the content
 * type above so the two cannot drift apart.
 */
export const HTML_MEDIA_TYPE = CONTENT_TYPE_HTML.split(';')[0] ?? 'text/html'

/**
 * What a person is told when the login is refused for rate limiting or a full
 * session pool rather than for the token. Like `UNKNOWN_TOKEN_NOTICE`, one
 * sentence for both causes: the 429s are byte-identical on purpose, and the
 * page must not become the oracle the JSON body refuses to be.
 */
export const TOO_MANY_ATTEMPTS_NOTICE =
  'Too many sign-in attempts, or the plane is holding all the sessions it will hold. Wait a minute and try again.'

/** Byte-identical for a missing, malformed, unknown or revoked credential. */
export const BODY_UNAUTHORIZED = Buffer.from('{"error":"unauthorized"}', 'utf8')
export const BODY_FORBIDDEN = Buffer.from('{"error":"forbidden"}', 'utf8')
/**
 * The one refusal that is deliberately NOT uniform: the caller presented a
 * session cookie that no longer resolves. It says nothing about the path it
 * was sent to (the answer is identical for a listed and an unlisted route) —
 * only that the credential the browser is holding is dead, which the page
 * script turns into a trip to `/login` instead of a meaningless toast.
 */
export const BODY_SESSION_EXPIRED = Buffer.from('{"error":"session-expired"}', 'utf8')

/**
 * How the page script tells the server "a `fetch()` is asking, not a browser
 * navigation". It decides the SHAPE of the dead-session refusal only — never
 * whether a request is allowed — so nothing is gained by forging it.
 */
export const SCRIPT_REQUEST_HEADER = 'x-requested-with'
export const SCRIPT_REQUEST_VALUE = 'fetch'
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
  "font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

// --- Branding -------------------------------------------------------------

/**
 * The product name shown in the page shell (`<title>` suffix, header brand) —
 * the McpCut console design (2026-08-22). One constant, so a rename is one
 * edit and the tests that pin the title format follow it automatically.
 */
export { BRAND_NAME } from '../brand.js'

/**
 * The status-line suffix in the header ("journal · local instance"). The UI
 * binds to loopback by default (ADR-0004) and has no notion of a remote
 * deployment name, so "local instance" is a statement of fact, not a label.
 */
export const INSTANCE_LABEL = 'local instance'

/** Warning printed to stderr when the UI binds a non-localhost host. */
export const NON_LOCALHOST_BIND_WARNING =
  '[ui] binding to non-localhost host; terminate TLS in front and restrict access'

/** Additional warning for a wildcard UI bind. */
export const WILDCARD_BIND_WARNING =
  '[ui] wildcard bind: Host screening admits only localhost names and explicit ' +
  'allowlist entries; remote clients will get 403 unless --allowed-host names them'

// --- Audit evidence -------------------------------------------------------

/**
 * The line a success page carries when the change landed but its audit record
 * (`access-edit` / `policy-edit`) was dropped by the journal (security audit
 * 2026-09-02, F1). The writers never throw and never roll the change back — a
 * journal that cannot be reached must not turn a completed change into a
 * failed request — so the only honest answer is a success that says, in the
 * admin's own browser, that the evidence is missing. Until this line existed
 * the drop was reported on the server process's stderr alone, which the
 * browser-side admin never sees; an auditor would later find a clean chain
 * with no trace of the change and nothing to say why.
 */
export const AUDIT_RECORD_DROPPED_WARNING =
  'The change was applied, but its audit record was NOT written to the journal — ' +
  'check the server log and the journal integrity before relying on the evidence.'
