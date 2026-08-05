import { z } from 'zod'
import { RESERVED_OBJECT_KEYS, TOOL_RULE_NAME_PATTERN } from '../policy/constants.js'
import {
  AGENT_NAME_PATTERN,
  GRANT_SERVER_NAME_PATTERN,
  MAX_AGENTS,
  MAX_GRANTS_PER_AGENT,
  MAX_TOOLS_PER_GRANT,
  TOKEN_HASH_PATTERN,
} from './constants.js'

/**
 * zod schema for `agents.json`. Like `policy/schema.ts`, this file is a trust
 * boundary (the store is CLI-managed, but a corrupt or hand-edited file must
 * fail LOUDLY, never degrade into "agent has no grants" or — worse — "token
 * matches nothing" silently): every object is `z.strictObject`, maps reject
 * reserved keys, and `parseAgentsFile` pre-scans the raw value for
 * `__proto__` before zod can silently drop it.
 *
 * Tool patterns reuse `TOOL_RULE_NAME_PATTERN` from policy — grants and
 * policy rules share ONE pattern syntax by construction (plan decision:
 * "синтаксис паттернов — тот же, что в policy").
 */

const agentNameSchema = z
  .string()
  .regex(AGENT_NAME_PATTERN, 'agent name must match ^[a-z0-9][a-z0-9-]{0,63}$')

const grantServerNameSchema = z
  .string()
  .regex(GRANT_SERVER_NAME_PATTERN, 'server name must match ^[a-z0-9][a-z0-9-]{0,63}$')

/**
 * A grantable tool pattern: exact tool name or single trailing `*`, same
 * syntax as policy rules. Reserved object keys are rejected even though
 * grants keep tools in an ARRAY (not a map): `scope.ts` builds a lookup map
 * from these values, and policy rejects the same names in its rule maps —
 * one uniform rule beats two subtly different ones.
 */
const toolPatternSchema = z
  .string()
  .regex(TOOL_RULE_NAME_PATTERN, 'tool pattern must be an exact name or end with a single "*"')
  .refine((pattern) => !RESERVED_OBJECT_KEYS.includes(pattern), {
    message: 'reserved name is not allowed as a tool pattern',
  })

/**
 * Caps a `Record<key, value>` map at `max` entries and LOUDLY rejects
 * reserved keys (`__proto__`/`constructor`/`prototype`). Local sibling of the
 * identical helper in `policy/schema.ts` (not exported there; policy files
 * are out of this task's ownership — same precedent as `classify-tool.ts`
 * mirroring `match.ts`).
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

const agentGrantSchema = z.strictObject({
  /** `'*'` — every tool granted; array — exact names / trailing-`*` prefixes. */
  tools: z.union([z.literal('*'), z.array(toolPatternSchema).max(MAX_TOOLS_PER_GRANT)]),
})

/** One agent's grant for one server. */
export type AgentGrant = z.infer<typeof agentGrantSchema>

export const agentRecordSchema = z.strictObject({
  name: agentNameSchema,
  tokenHash: z.string().regex(TOKEN_HASH_PATTERN, 'tokenHash must be a sha256 hex digest'),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().optional(),
  grants: withMaxEntries(grantServerNameSchema, agentGrantSchema, MAX_GRANTS_PER_AGENT, 'grants'),
})

/** One agent: identity (hash only, never a plaintext token) plus its grant matrix. */
export type AgentRecord = z.infer<typeof agentRecordSchema>

export const agentsFileSchema = z.strictObject({
  version: z.literal(1),
  agents: withMaxEntries(agentNameSchema, agentRecordSchema, MAX_AGENTS, 'agents').superRefine(
    (agents, ctx) => {
      for (const [key, record] of Object.entries(agents)) {
        if (record.name !== key) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `agents key "${key}" does not match the record's name "${record.name}"`,
            path: [key, 'name'],
          })
        }
      }
    },
  ),
})

/** The whole `agents.json` document. */
export type AgentsFile = z.infer<typeof agentsFileSchema>

/** Discriminated result of validating an agents file. Never throws. */
export type ParseAgentsResult =
  | { readonly ok: true; readonly file: AgentsFile }
  | { readonly ok: false; readonly error: z.ZodError }

/**
 * Validates a raw, untrusted value (parsed JSON from disk). Pre-scans for
 * reserved own-keys first: `JSON.parse` materializes `__proto__` as an own
 * property but zod's record rebuild silently drops it BEFORE `superRefine`
 * runs, which would turn a smuggled `__proto__` grant into a silently
 * vanished one (same fail-open hazard `policy/schema.ts` documents).
 */
export function parseAgentsFile(value: unknown): ParseAgentsResult {
  const reservedPath = findReservedKeyPath(value, [])
  if (reservedPath) {
    const error = new z.ZodError([
      {
        code: 'custom',
        message: `reserved key "${String(reservedPath.at(-1))}" is not allowed`,
        path: reservedPath,
      },
    ])
    return { ok: false, error }
  }

  const result = agentsFileSchema.safeParse(value)
  if (result.success) {
    return { ok: true, file: result.data }
  }
  return { ok: false, error: result.error }
}

const RESERVED_SCAN_MAX_DEPTH = 32

/** Depth-bounded scan for a reserved own-key anywhere in `value`; returns its path or null. */
function findReservedKeyPath(
  value: unknown,
  path: readonly (string | number)[],
): (string | number)[] | null {
  if (path.length > RESERVED_SCAN_MAX_DEPTH || typeof value !== 'object' || value === null) {
    return null
  }
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
