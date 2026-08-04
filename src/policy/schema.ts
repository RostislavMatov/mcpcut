import { z } from 'zod'
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_GRANT_TTL_MS,
  MAX_SERVERS_IN_POLICY,
  MAX_TOOL_RULES_PER_SERVER,
  RESERVED_OBJECT_KEYS,
  TOOL_RULE_NAME_PATTERN,
} from './constants.js'

/**
 * zod schema for `policy.json`. This file is a trust boundary: it is hand
 * edited by an operator, and a typo (`"tols"` instead of `"tools"`, a
 * misspelled outcome) must fail loudly rather than silently degrading a
 * `deny` rule into "rule never matched, falls through to default". Every
 * object in this schema is therefore `z.strictObject`, which rejects unknown
 * keys instead of stripping them.
 */

/** A server name, or a proxy-generated `auto:<sha256 prefix>` identity. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/

/** Every outcome a policy rule can resolve to. */
export const POLICY_OUTCOME_VALUES = ['allow', 'deny', 'require-approval'] as const

/** Result of matching a tool call against the policy: what happens to it. */
export type PolicyOutcome = (typeof POLICY_OUTCOME_VALUES)[number]

/** The three risk classes a tool is bucketed into (see `classify-tool.ts`). */
export const TOOL_CLASS_VALUES = ['read', 'write', 'destructive'] as const

/** Risk class assigned to a tool by annotations + name heuristics. */
export type ToolClass = (typeof TOOL_CLASS_VALUES)[number]

const policyOutcomeSchema = z.enum(POLICY_OUTCOME_VALUES)
const toolClassSchema = z.enum(TOOL_CLASS_VALUES)

/**
 * A tool-rule map key: exact tool name, or a name with a single trailing
 * glob (`prefix*`). Rejects embedded/mid-name wildcards (`a*b`) so rule
 * matching never needs a full regex engine.
 */
const toolRuleNameSchema = z
  .string()
  .regex(TOOL_RULE_NAME_PATTERN, 'tool rule name must be an exact name or end with a single "*"')

const serverNameSchema = z
  .string()
  .regex(SERVER_NAME_PATTERN, 'server name must match ^[A-Za-z0-9_.:-]{1,64}$')

/**
 * Caps a `Record<key, value>` map at `max` entries, and LOUDLY rejects the
 * reserved keys `__proto__`/`constructor`/`prototype`. zod's `z.record`
 * happily strips a `__proto__` key (JSON.parse materializes it as an own
 * property, but many code paths silently drop it), which would turn a
 * `{"__proto__":"deny"}` rule into "rule never matched, falls through to a
 * looser default" — a fail-OPEN downgrade. `Object.getOwnPropertyNames`
 * observes the reserved keys even when `Object.keys` would hide them.
 */
function withMaxEntries<V extends z.ZodTypeAny>(
  keySchema: z.ZodString,
  valueSchema: V,
  max: number,
  what: string,
) {
  return z
    .record(keySchema, valueSchema)
    .refine((map) => Object.keys(map).length <= max, { message: `too many ${what}: max ${max}` })
    .superRefine((map, ctx) => {
      for (const key of Object.getOwnPropertyNames(map)) {
        if (RESERVED_OBJECT_KEYS.includes(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `reserved key "${key}" is not allowed in ${what}`,
            path: [key],
          })
        }
      }
    })
}

const classDefaultsSchema = z
  .strictObject({
    read: policyOutcomeSchema.optional(),
    write: policyOutcomeSchema.optional(),
    destructive: policyOutcomeSchema.optional(),
  })
  .optional()

// `.prefault()` (not `.default()`) is required here: zod v4's `.default()`
// short-circuits and returns the literal `{}` without running it through the
// inner object schema, so the field-level defaults below (`enabled: true`,
// `filter: 'hide-denied'`, ...) would never be applied when the whole section
// is omitted. `.prefault()` runs the fallback through the schema.
const quarantineSchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    onQuarantined: z.enum(['deny', 'require-approval']).default('require-approval'),
  })
  .prefault({})

const toolsListSchema = z
  .strictObject({
    filter: z.enum(['hide-denied', 'off']).default('hide-denied'),
  })
  .prefault({})

const approvalSchema = z
  .strictObject({
    timeoutMs: z.number().int().positive().default(DEFAULT_APPROVAL_TIMEOUT_MS),
    onTimeout: z.literal('deny').default('deny'),
    grantTtlMs: z.number().int().positive().default(DEFAULT_GRANT_TTL_MS),
  })
  .prefault({})

const journalSchema = z
  .strictObject({
    failClosed: z.boolean().default(false),
  })
  .prefault({})

const serverPolicySchema = z.strictObject({
  defaultDecision: policyOutcomeSchema.optional(),
  classOverrides: withMaxEntries(
    toolRuleNameSchema,
    toolClassSchema,
    MAX_TOOL_RULES_PER_SERVER,
    'classOverrides entries',
  ).optional(),
  tools: withMaxEntries(
    toolRuleNameSchema,
    policyOutcomeSchema,
    MAX_TOOL_RULES_PER_SERVER,
    'tools entries',
  ).optional(),
})

const serversSchema = withMaxEntries(serverNameSchema, serverPolicySchema, MAX_SERVERS_IN_POLICY, 'servers').optional()

/**
 * Full policy document schema. `.superRefine` is not needed for the map size
 * limits (they are enforced per-map via `withMaxEntries`), keeping the shape
 * declarative and each error attached to the exact path that violated it.
 */
export const policySchema = z.strictObject({
  version: z.literal(1),
  defaultDecision: policyOutcomeSchema.default('require-approval'),
  classDefaults: classDefaultsSchema,
  quarantine: quarantineSchema,
  toolsList: toolsListSchema,
  approval: approvalSchema,
  journal: journalSchema,
  servers: serversSchema,
})

/** A fully parsed, defaulted policy document. */
export type Policy = z.infer<typeof policySchema>

/** Discriminated result of validating a policy document. Never throws. */
export type ParsePolicyResult =
  | { readonly ok: true; readonly policy: Policy }
  | { readonly ok: false; readonly error: z.ZodError }

/**
 * Validates and applies defaults to a raw, untrusted value (parsed JSON from
 * disk). Uses `safeParse` rather than `parse`: callers (CLI, proxy startup)
 * decide how to surface a bad policy, this function never throws.
 */
export function parsePolicy(value: unknown): ParsePolicyResult {
  // `__proto__` is materialized as an own property by `JSON.parse` but is
  // silently dropped by zod's record rebuild BEFORE any `superRefine` can see
  // it -- so a `{"__proto__":"deny"}` rule would vanish (a fail-open
  // downgrade). Scan the raw input for reserved keys up front and reject
  // loudly. (`constructor`/`prototype` survive to `withMaxEntries`'s
  // `superRefine`; scanning here covers all three uniformly.)
  const reservedPath = findReservedKeyPath(value, [])
  if (reservedPath) {
    const error = new z.ZodError([
      {
        code: 'custom',
        message: `reserved key "${reservedPath.at(-1)}" is not allowed`,
        path: reservedPath,
      },
    ])
    return { ok: false, error }
  }

  const result = policySchema.safeParse(value)
  if (result.success) {
    return { ok: true, policy: result.data }
  }
  return { ok: false, error: result.error }
}

/** Depth-bounded scan for a reserved own-key anywhere in `value`; returns its path or null. */
function findReservedKeyPath(value: unknown, path: readonly (string | number)[]): (string | number)[] | null {
  if (path.length > 32 || typeof value !== 'object' || value === null) return null
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findReservedKeyPath(value[i], [...path, i])
      if (hit) return hit
    }
    return null
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (RESERVED_OBJECT_KEYS.includes(key)) return [...path, key]
    const hit = findReservedKeyPath((value as Record<string, unknown>)[key], [...path, key])
    if (hit) return hit
  }
  return null
}
