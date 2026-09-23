/**
 * Limits and literals of the agent pool multiplexer (`src/pool/*`, ADR-0015).
 * Kept out of `src/config.ts` per the M2 convention: each area owns its own
 * `constants.ts` instead of sharing a dumping ground.
 *
 * Nothing here is a spec literal — MCP method names and protocol versions live
 * in `src/protocol/mcp.ts`, the single point of coupling to the spec.
 */

import { INITIALIZE_METHOD } from '../protocol/mcp.js'
import { SERVER_DISCOVER_METHOD } from '../protocol/mcp-stateless.js'

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

/**
 * How long one upstream may take to answer one fan-out list request before
 * it is detached (plan decision P4). Leaving the request hanging would pile
 * correlation entries up against `MAX_POOL_PENDING_REQUESTS`; detaching frees
 * them all with one `dropServer` and gives the agent an honest reason to read
 * the list again.
 */
export const POOL_FANOUT_TIMEOUT_MS = 10_000

/**
 * How long ONE server may take to come up in a pool: opening, spawning and
 * the whole negotiation, both steps of it, under ONE deadline (BU1). Servers
 * start at once, so five of them wait as long as the slowest, not five times
 * as long. 40 s plus the 10 s list that follows stays under the 60-second
 * request timeout of the official SDKs; `npx -y` of four packages on a
 * 2-CPU host took ~14 s in the phase-5 smoke (Ф2), which the 10-second budget
 * this replaces did not survive. Mostly an upper bound now: servers granted
 * to an agent are already running when it connects (ADR-0016).
 */
export const POOL_CHILD_START_TIMEOUT_MS = 40_000

/** Fan-out tag of the plane's own handshake with an upstream: its method name. */
export const POOL_TAG_INITIALIZE = INITIALIZE_METHOD

/** Fan-out tag of the `server/discover` that follows a refused handshake (RV1). */
export const POOL_TAG_DISCOVER = SERVER_DISCOVER_METHOD

/**
 * Fan-out tags of the requests that make up a START (the plane's handshake
 * and its `server/discover` fallback). A start that runs out of budget is
 * reported as `attach-refused`, so a timeout on these is not a member to
 * detach — it was never a member.
 */
export const POOL_START_TAGS: ReadonlySet<string> = new Set([POOL_TAG_INITIALIZE, POOL_TAG_DISCOVER])

/**
 * Pages of ONE upstream's catalog the pool drains before giving up on the
 * rest. A server that pages further than this is either enormous or looping;
 * either way the merge has long since outgrown what a client will accept.
 */
export const MAX_POOL_LIST_PAGES = 50

/**
 * The departure reason of a server whose grant was withdrawn (DR1). One word
 * whichever watch notices first: the pool's own, or the child session's,
 * which ends that session as `revoked`.
 */
export const POOL_DEPARTURE_UNGRANTED = 'ungranted'

/**
 * The departure a pool session writes for a server it still had requests in
 * flight at when it closed (ADR-0016, RS5, RS9). Such a child leaves DIRTY: a
 * held session is then closed rather than kept, because a reply still on its
 * way must never reach the next pool session to attach.
 */
export const POOL_DEPARTURE_IN_FLIGHT_AT_CLOSE = 'in-flight-at-close'

/**
 * Child sessions ONE pool session may hold. The process-wide ceiling already
 * counts them (`MAX_CONCURRENT_SESSIONS` via `extraSessions`); this one stops
 * a single agent with broad grants from taking all of it. A pool past this
 * size has also outgrown what client tool limits hold (PRD research: Cursor
 * caps active tools around 40).
 */
export const MAX_POOL_CHILD_SESSIONS = 32

/**
 * "The server serving this call has left the pool." Next free code after the
 * proxy's own (-32001 policy, -32002 approval, -32003 quarantine) and the
 * bridge's transport code (-32004, `src/bridge/constants.ts`). Distinct on
 * purpose: an agent may retry this one against a re-granted server, which is
 * not true of any decision the plane made.
 */
export const ERROR_CODE_POOL_MEMBER_GONE = -32005

/**
 * "The pool is tracking as many requests as it will." Deliberately NOT
 * -32005: that one says the server left, which an agent may reasonably retry
 * against a re-granted server. This one says "try again shortly", and a code
 * that conflated the two would send agents to the wrong remedy.
 */
export const ERROR_CODE_POOL_AT_CAPACITY = -32006

/**
 * "The server asked for input, or for a retry, that the pool cannot provide"
 * (RV5). Next free code after -32006. Distinct from both neighbours: the
 * server is still here (not -32005) and the pool is not full (not -32006) —
 * calling again is what may help, because a 2026-07-28 server that sheds load
 * with a bare `requestState` usually answers the next call in full.
 */
export const ERROR_CODE_POOL_INCOMPLETE_RESULT = -32007

/** JSON-RPC "Method not found": the pool declares only tools and prompts (PE3). */
export const ERROR_CODE_POOL_METHOD_NOT_FOUND = -32601

/** JSON-RPC "Invalid params": a `cursor` the pool never issued (P6). */
export const ERROR_CODE_POOL_INVALID_PARAMS = -32602

/**
 * Distinct (server, reason, method) keys one pool session journals a dropped
 * NOTIFICATION under (ADR-0015 phase 5, N3). Each one is recorded once for the
 * life of the session: every such notification is already in the child
 * session's own traffic, so the pool's record adds only the fact that the pool
 * did not pass it on -- once. A chatty upstream (a log line every second)
 * would otherwise double the journal. Past this many keys nothing more is
 * noted; the child's traffic still holds all of it.
 */
export const MAX_POOL_NOTIFICATION_DROP_NOTES = 256

/**
 * How much of a dropped notification's `method` the pool keeps -- as the
 * once-per-kind key and in the record. The method is chosen by the upstream,
 * so without a bound 256 notes of several kilobytes each would sit in memory
 * for the life of the session (phase-5 security review, LOW). Two methods
 * sharing this long a prefix are one kind, which is all a note says.
 */
export const MAX_POOL_DROP_NOTE_METHOD_CHARS = 128

/**
 * (agent, stdio server) pairs the plane keeps running with no agent attached
 * (ADR-0016, RS2; owner decision "up to 32"). Half of the front's 64: the
 * other half stays for live sessions, and a warm server yields its slot to
 * live work whenever the budget runs short (RS7).
 */
export const MAX_POOL_RESIDENTS = 32

/**
 * How long a server started on demand (past `MAX_POOL_RESIDENTS`) stays up
 * after its last agent left (RS8; owner decision D5, "10 minutes"): the same
 * agent reconnecting within it gets the same process, not a new start.
 */
export const POOL_WARM_IDLE_MS = 10 * 60_000

/**
 * Idle warm servers kept at once, across the service (owner decision "up to
 * 32"). Past it the longest idle goes first; residents never go.
 */
export const MAX_POOL_WARM_IDLE = 32
