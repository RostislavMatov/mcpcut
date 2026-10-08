/**
 * Constants for the transport-neutral session core (`session/core.ts`).
 */

/**
 * How often a live session re-reads `agents.json` to pick up revocation and
 * grant changes (plan decision: revocation is one action; live sessions
 * follow by polling within ≤ 5 s — the same mechanic approvals use, no
 * `fs.watch`). Injectable per session for tests; this is the default and
 * the contractual upper bound.
 */
export const AGENT_REVOCATION_POLL_INTERVAL_MS = 5_000

/** `rule` of the decision record journaled when a revocation ends a session. */
export const AGENT_REVOKED_RULE = 'agent-revoked'

/**
 * `toolName` stamped on session-lifecycle decision records (no tool was
 * involved; the subject is the session itself).
 */
export const SESSION_TOOL_NAME = '<session>'

/**
 * How long a session whose agent left keeps reading its server for the
 * answers to calls already sent (decision M36, phase C: "the server finishes
 * what it started"), before the server is let go. Ends early once nothing is
 * owed. Injectable per session for tests.
 */
export const FORWARDED_ANSWER_GRACE_MS = 30_000
