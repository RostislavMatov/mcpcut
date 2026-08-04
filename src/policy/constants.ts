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
 * file whose `resolvedAt` is more than this far in the FUTURE is rejected, so
 * a forged/backdated file cannot mint a grant.
 */
export const GRANT_CLOCK_SKEW_MS = 5_000

/**
 * Max resolved files `checkRecentApproval` will `readdir`/`stat` on the
 * approval hot path. Bounds the cost of a huge, never-pruned `resolved/`
 * directory: only the first this-many directory entries are considered.
 */
export const MAX_RESOLVED_FILES_SCANNED = 2000

/**
 * Resolved-file retention: `checkRecentApproval` opportunistically deletes
 * resolved files older than this (well past any grant TTL), so the directory
 * cannot grow without bound across a long-lived proxy session.
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

/** Default file name looked up in the project/home policy directories. */
export const POLICY_FILE_NAME = 'policy.json'

/** Environment variable that can point at an explicit policy file path. */
export const POLICY_ENV_VAR = 'MCP_JOURNAL_POLICY'
