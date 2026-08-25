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
 * name; `force_` is a prefix, the rest are matched as whole tokens by
 * `classify-tool.ts`.
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
  'wipe',
  'erase',
  'rm',
  'overwrite',
  'kill',
  'shutdown',
  'chmod',
  'exec',
  'transfer',
  'send',
  'terminate',
  'force_',
]

/**
 * Homoglyph fold used ONLY to escalate the destructive-name heuristic
 * (`classify-tool.ts`): maps common Cyrillic/Greek/fullwidth confusables to
 * their ASCII look-alike so a tool named with a Cyrillic `е` in `dеlete_all`
 * still trips the `delete` heuristic. Escalation-only: this fold can never
 * lower a classification, so an occasional false collapse (e.g. Greek `ο`→`o`)
 * only ever makes a name look *more* destructive, which is the safe direction.
 */
export const CONFUSABLE_FOLD: Readonly<Record<string, string>> = {
  а: 'a', // Cyrillic a
  е: 'e', // Cyrillic e
  о: 'o', // Cyrillic o
  р: 'p', // Cyrillic er
  с: 'c', // Cyrillic es
  х: 'x', // Cyrillic ha
  у: 'y', // Cyrillic u
  і: 'i', // Cyrillic dotted i
  ѕ: 's', // Cyrillic dze
  к: 'k', // Cyrillic ka
  м: 'm', // Cyrillic em
  т: 't', // Cyrillic te
  ν: 'v', // Greek nu (look-alike)
  ο: 'o', // Greek omicron
  ρ: 'p', // Greek rho
  τ: 't', // Greek tau
  ι: 'i', // Greek iota
  κ: 'k', // Greek kappa
}

/**
 * Object keys that must never be used as a map key in the inventory store
 * (`inventory.ts`): a tool literally named `__proto__`/`constructor`/
 * `prototype` would either poison the prototype chain or round-trip to a
 * plain-object key that loses its record and corrupts the whole shared store
 * file. These names are handled with a `reserved:` prefix instead of being
 * written verbatim.
 */
export const RESERVED_OBJECT_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype']

/**
 * Max characters of a tool's `description` kept before storing a quarantined
 * entry's descriptor copy. A malicious/compromised server can advertise an
 * arbitrarily large description; this bounds both the redaction work and the
 * store file size. The schema hash (used for known/new/changed comparisons)
 * is computed on the original, uncapped descriptor, so truncation here never
 * affects rug-pull detection.
 */
export const MAX_STORED_DESCRIPTION_CHARS = 4096

/**
 * Hard cap on quarantined tools persisted per server. A hostile/compromised
 * server can advertise an unbounded `tools/list`; past this cap the inventory
 * stops adding new quarantine entries and marks the catalog untrusted (so
 * `decide` fails closed) rather than growing the store file without bound.
 */
export const MAX_QUARANTINED_TOOLS_PER_SERVER = 2000

/**
 * Max serialized (JSON) length of a stored quarantined descriptor copy. The
 * schema hash already pins the full descriptor, so the stored copy is only
 * for human display and can be aggressively bounded.
 */
export const MAX_STORED_DESCRIPTOR_CHARS = 8192

/**
 * Clock-skew tolerance (ms) for `checkRecentApproval` (grants.ts): a resolved
 * record whose `resolvedAt` is more than this far in the FUTURE is rejected, so
 * a forged/backdated record cannot mint a grant.
 */
export const GRANT_CLOCK_SKEW_MS = 5_000

/**
 * Max characters of an approval resolution's `actor` (`queue-file.ts`). The
 * two producers are short and bounded by construction — `cli` and
 * `ui:<adminName>`, where an admin name is at most 64 chars
 * (`ADMIN_NAME_PATTERN`) — so 128 is ample headroom for a longer prefixed
 * form while still bounding a value that arrives as untrusted text. A
 * resolved record comes back from storage hand-editable (a legacy file, a
 * foreign row), and this field is about to become signed evidence of WHO
 * authorized a destructive operation: without a cap, a row written out of
 * band could push megabytes of attacker-chosen text into the journal and
 * into the hash chain. Over-cap does not truncate — the record is skipped
 * whole, like every other failed field here.
 */
export const MAX_APPROVAL_ACTOR_CHARS = 128

/**
 * Resolved-record retention: `checkRecentApproval` opportunistically deletes
 * resolved approvals settled longer ago than this (well past any grant TTL), so
 * the queue cannot grow without bound across a long-lived proxy session.
 */
export const RESOLVED_FILE_RETENTION_MS = 24 * 60 * 60_000

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

/**
 * Request methods that reach a server's capability surface but have no
 * representation in an agent's grant matrix: M3 grants are a tool allowlist
 * (`agents.json`: `grants: {<server>: {tools: [...]}}`) and say nothing about
 * resources, prompts or completions. An agent session therefore denies them
 * fail-closed -- a `tools` grant must not become a back door through which
 * `resources/read` reaches the same server. Sessions with no agent identity
 * (ad-hoc `wrap`) are untouched: there is no grant matrix to be inconsistent
 * with.
 *
 * An entry ending in `/` names a whole family (`resources/*`, `prompts/*`) so
 * a method added by a later spec revision is denied by default rather than
 * silently admitted; every other entry is an exact method name. Protocol
 * plumbing (`initialize`, `ping`, `tools/*`, `notifications/*`, `logging/*`)
 * is deliberately absent -- an agent session cannot work without it.
 *
 * Since M4 (Task 6) this list is GRANT-MANAGED rather than an unconditional
 * ban: the router first consults the enumerated grant vocabulary in
 * `src/agents/method-grants.ts` (`resources/read|list|subscribe|unsubscribe`,
 * `prompts/get|list`, `completion/complete`) against the agent's
 * `resources`/`prompts` grants, and only what no grant covers — including
 * every family member NOT enumerated there, and everything when the grant
 * fields are absent — falls back to the fail-closed denial below, byte for
 * byte the M3 behavior. Policy rules for these methods remain out of scope
 * (M5 backlog): grants decide, the journal records.
 */
export const AGENT_NON_GRANTABLE_METHODS: readonly string[] = [
  'resources/',
  'prompts/',
  'completion/complete',
]

/** Prefix of the `rule` recorded for a method denied by `AGENT_NON_GRANTABLE_METHODS`. */
export const AGENT_NON_GRANTABLE_RULE_PREFIX = 'agent: method not grantable in M3'

/** Default file name looked up in the project/home policy directories. */
export const POLICY_FILE_NAME = 'policy.json'

/** Environment variable that can point at an explicit policy file path. */
export const POLICY_ENV_VAR = 'MCP_JOURNAL_POLICY'

/**
 * Max serialized (JSON) length of a stored `inputSchema` copy (M4, reversing
 * the M10 "always drop the schema" decision so the quarantine UI/CLI can show
 * a structural diff instead of "hashes diverged"). A schema past this cap is
 * replaced by a top-level summary (property names + required) and the record
 * is flagged `schemaTruncated`. The schema HASH is still computed on the
 * original, uncapped descriptor, so truncation never affects detection.
 */
export const MAX_STORED_SCHEMA_CHARS = 4096

/**
 * Max property/required names kept in the summary that replaces an oversized
 * stored `inputSchema`, and the max characters kept per name. Bounds the
 * summary itself against a hostile schema with millions of huge names.
 */
export const MAX_SCHEMA_SUMMARY_NAMES = 100
export const MAX_SCHEMA_SUMMARY_NAME_CHARS = 128

/**
 * Recursion cap for `schema-diff.ts`. Schemas come from an untrusted server;
 * past this depth the diff stops descending and reports `truncated: true`
 * instead of recursing without bound (it must never throw).
 */
export const SCHEMA_DIFF_MAX_DEPTH = 32

/**
 * Cap on the number of changes a single schema diff reports. A hostile server
 * can add thousands of properties in one update; past this cap further
 * changes are dropped and the diff reports `truncated: true`.
 */
export const SCHEMA_DIFF_MAX_CHANGES = 200

/**
 * Minimum interval between two `stat` checks of the policy file by a running
 * proxy (`policy/reload.ts`). Hot reload is polled from the gate's own hot
 * path — before a decision, before a `tools/list` rewrite — so the check has
 * to be cheap even under a burst of calls: at most one `stat` per this many
 * milliseconds, and the read itself only when `mtime`/`size` moved. No
 * `fs.watch`, for the same reason `APPROVAL_POLL_INTERVAL_MS` has none: watch
 * semantics differ across platforms and network filesystems, and a stat-based
 * check is predictable everywhere and holds no descriptor per process.
 */
export const POLICY_RECHECK_MIN_MS = 250
