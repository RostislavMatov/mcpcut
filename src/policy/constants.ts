/**
 * Defaults and limits for `src/policy/schema.ts` and the policy engine built
 * on top of it. Kept out of `src/config.ts` so the two files have distinct,
 * non-overlapping owners (see M2 plan) instead of becoming a shared dumping
 * ground.
 */

/**
 * Default time a `require-approval` decision waits for a human response
 * before resolving to `onTimeout` (deny). Chosen to sit comfortably below
 * common MCP client timeouts (research: Claude Code cuts calls off around
 * `MCP_TIMEOUT`, and >2 min calls move to background), so the operator has a
 * realistic window without the client giving up first.
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000

/**
 * Default lifetime of a grant created when an operator approves a call after
 * its timeout already fired. Lets an agent's retry succeed without a second
 * manual approval, without leaving the door open indefinitely.
 */
export const DEFAULT_GRANT_TTL_MS = 5 * 60_000

/**
 * Polling interval for the approval waiter. M2 deliberately uses polling
 * only (no `fs.watch`): watch semantics are inconsistent across platforms
 * and network filesystems and would need a polling fallback anyway (YAGNI).
 */
export const APPROVAL_POLL_INTERVAL_MS = 300

/**
 * Tool-name fragments that, when present, raise a tool's classification to
 * `destructive` even without a matching `destructiveHint` annotation. A
 * server must not be able to self-declare `drop_database` as safe merely by
 * omitting or lying about annotations -- these heuristics only ever raise
 * the class, never lower it. Matched case-insensitively against the tool
 * name; `force_` is a prefix, the rest are substrings.
 */
export const DESTRUCTIVE_NAME_HEURISTICS: readonly string[] = [
  'delete',
  'drop',
  'remove',
  'purge',
  'truncate',
  'revoke',
  'destroy',
  'reset',
  'force_',
]

/**
 * Max number of server entries a single policy file may define under
 * `servers`. Guards against a pathological config turning validation and
 * `policy show` into an unbounded-cost operation.
 */
export const MAX_SERVERS_IN_POLICY = 100

/**
 * Max number of tool rules (`classOverrides` + `tools` combined is not
 * enforced here; each map is capped independently) a single server entry
 * may define. Same rationale as MAX_SERVERS_IN_POLICY.
 */
export const MAX_TOOL_RULES_PER_SERVER = 500

/**
 * Shape of a tool-rule key: an exact tool name, or a name with a single
 * trailing glob (`prefix*`). No mid-name or multiple wildcards -- rule
 * matching (`policy/match.ts`) only ever needs "exact" or "longest prefix",
 * never a full regex engine.
 */
export const TOOL_RULE_NAME_PATTERN = /^[A-Za-z0-9_.:-]+\*?$/

/** Default file name looked up in the project/home policy directories. */
export const POLICY_FILE_NAME = 'policy.json'

/** Environment variable that can point at an explicit policy file path. */
export const POLICY_ENV_VAR = 'MCP_JOURNAL_POLICY'
