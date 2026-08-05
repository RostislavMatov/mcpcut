import { z } from 'zod'
import { REDACT_VALUE_PATTERNS } from '../config.js'
import { RESERVED_OBJECT_KEYS } from '../policy/constants.js'
import { isSensitiveKey } from '../redact/patterns.js'
import {
  DEFAULT_HTTP_PROTOCOL,
  ENV_NAME_PATTERN,
  HEADER_NAME_PATTERN,
  HTTP_PROTOCOL_VALUES,
  MAX_ARGS_PER_SERVER,
  MAX_ENV_ENTRIES_PER_SERVER,
  MAX_HEADER_ENTRIES_PER_SERVER,
  MAX_RECORD_VALUE_CHARS,
  MAX_SERVERS_IN_REGISTRY,
  REGISTRY_SERVER_NAME_PATTERN,
  RESERVED_SERVER_NAME_PREFIX,
  VAULT_REF_PATTERN,
  VAULT_REF_PREFIX,
} from './constants.js'

/**
 * zod schema for `registry.json`. Like `policy/schema.ts`, this file guards a
 * trust boundary — but with an extra invariant: **secrets never enter the
 * registry**. An env/header value is either a `vault:<name>` reference or a
 * non-secret literal; anything that *looks* like a secret (sensitive key name
 * or secret-shaped value) is a validation error pointing the operator at the
 * vault. That makes "secrets live only in the vault" a property of the
 * schema, not an act of discipline.
 */

const boundedString = z.string().min(1).max(MAX_RECORD_VALUE_CHARS)

const serverNameSchema = z.string().superRefine((name, ctx) => {
  if (name.startsWith(RESERVED_SERVER_NAME_PREFIX)) {
    ctx.addIssue({
      code: 'custom',
      message: `server name must not start with "${RESERVED_SERVER_NAME_PREFIX}" (reserved for proxy-generated identities)`,
    })
    return
  }
  if (!REGISTRY_SERVER_NAME_PATTERN.test(name)) {
    ctx.addIssue({
      code: 'custom',
      message: `server name must match ${REGISTRY_SERVER_NAME_PATTERN.source}`,
    })
  }
})

/**
 * True when storing `value` under `key` would put a secret into the registry
 * file. Two independent heuristics, either one trips it:
 * - the KEY is sensitive (`isSensitiveKey`: `GITHUB_TOKEN`, `Authorization`,
 *   ...) — then ANY literal is refused, even one that does not look like a
 *   secret, because a value under such a key is a secret by declaration;
 * - the VALUE matches a known secret shape (`REDACT_VALUE_PATTERNS`: Bearer,
 *   PATs, JWTs, ...), whatever the key is called.
 * Vault references are checked separately and never reach this function.
 */
export function looksLikeSecretLiteral(key: string, value: string): boolean {
  if (isSensitiveKey(key)) {
    return true
  }
  // Global regexes carry mutable lastIndex state; clone before testing.
  return REDACT_VALUE_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags).test(value))
}

function secretLiteralMessage(key: string): string {
  return (
    `value for "${key}" looks like a secret literal; secrets must not live in the registry. ` +
    `Put the value in the vault (mcp-journal vault set <name>) and reference it as ${VAULT_REF_PREFIX}<name>`
  )
}

/**
 * Validates one env/header entry: a `vault:` value must be a well-formed
 * reference; any other value is a literal and must not look like a secret.
 */
function checkSecretSafeEntry(key: string, value: string, ctx: z.RefinementCtx): void {
  if (value.startsWith(VAULT_REF_PREFIX)) {
    if (!VAULT_REF_PATTERN.test(value)) {
      ctx.addIssue({
        code: 'custom',
        message: `invalid vault reference "${value}": must match ${VAULT_REF_PATTERN.source}`,
        path: [key],
      })
    }
    return
  }
  if (looksLikeSecretLiteral(key, value)) {
    ctx.addIssue({ code: 'custom', message: secretLiteralMessage(key), path: [key] })
  }
}

/**
 * A `Record<name, value>` map (env or headers) that (a) caps its entry count,
 * (b) loudly rejects `__proto__`/`constructor`/`prototype` keys (same
 * fail-open concern as `policy/schema.ts`: zod silently drops `__proto__`,
 * so the primary defence is the raw pre-scan in `parseServerRecord` /
 * `parseRegistry`), and (c) enforces the vault-or-benign-literal rule per
 * entry.
 */
function secretSafeMapSchema(keyPattern: RegExp, keyWhat: string, max: number, what: string) {
  const keySchema = z.string().regex(keyPattern, `${keyWhat} must match ${keyPattern.source}`)
  return z.record(keySchema, boundedString).superRefine((map, ctx) => {
    const keys = Object.getOwnPropertyNames(map)
    if (keys.length > max) {
      ctx.addIssue({ code: 'custom', message: `too many ${what}: max ${max}` })
    }
    for (const key of keys) {
      if (RESERVED_OBJECT_KEYS.includes(key)) {
        ctx.addIssue({ code: 'custom', message: `reserved key "${key}" is not allowed in ${what}`, path: [key] })
        continue
      }
      const value = map[key]
      if (typeof value === 'string') {
        checkSecretSafeEntry(key, value, ctx)
      }
    }
  })
}

const envSchema = secretSafeMapSchema(ENV_NAME_PATTERN, 'env variable name', MAX_ENV_ENTRIES_PER_SERVER, 'env entries')

const headersSchema = secretSafeMapSchema(
  HEADER_NAME_PATTERN,
  'header name',
  MAX_HEADER_ENTRIES_PER_SERVER,
  'headers entries',
)

const httpUrlSchema = boundedString.superRefine((value, ctx) => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'url must be a valid absolute URL' })
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', message: 'url must use http or https' })
  }
})

const stdioServerSchema = z.strictObject({
  name: serverNameSchema,
  transport: z.literal('stdio'),
  command: boundedString,
  args: z.array(boundedString).max(MAX_ARGS_PER_SERVER).optional(),
  env: envSchema.optional(),
})

// `.prefault()` (not `.default()`): same zod v4 gotcha as `policy/schema.ts`
// — the fallback value is run through the schema instead of short-circuiting.
const httpServerSchema = z.strictObject({
  name: serverNameSchema,
  transport: z.literal('http'),
  url: httpUrlSchema,
  headers: headersSchema.optional(),
  protocol: z.enum(HTTP_PROTOCOL_VALUES).prefault(DEFAULT_HTTP_PROTOCOL),
})

/** One registry entry, discriminated on `transport`. */
export const serverRecordSchema = z.discriminatedUnion('transport', [stdioServerSchema, httpServerSchema])

export type StdioServerRecord = z.infer<typeof stdioServerSchema>
export type HttpServerRecord = z.infer<typeof httpServerSchema>
export type ServerRecord = z.infer<typeof serverRecordSchema>

/** Full `registry.json` document. */
export const registryFileSchema = z.strictObject({
  version: z.literal(1),
  servers: z.record(z.string(), serverRecordSchema).superRefine((servers, ctx) => {
    const keys = Object.getOwnPropertyNames(servers)
    if (keys.length > MAX_SERVERS_IN_REGISTRY) {
      ctx.addIssue({ code: 'custom', message: `too many servers: max ${MAX_SERVERS_IN_REGISTRY}` })
    }
    for (const key of keys) {
      if (RESERVED_OBJECT_KEYS.includes(key)) {
        ctx.addIssue({ code: 'custom', message: `reserved key "${key}" is not allowed in servers`, path: [key] })
        continue
      }
      const record = servers[key]
      if (record !== undefined && record.name !== key) {
        ctx.addIssue({
          code: 'custom',
          message: `servers map key "${key}" does not match the record's name "${record.name}"`,
          path: [key],
        })
      }
    }
  }),
})

export type RegistryFile = z.infer<typeof registryFileSchema>

/** Discriminated result of validating a single server record. Never throws. */
export type ParseServerRecordResult =
  | { readonly ok: true; readonly record: ServerRecord }
  | { readonly ok: false; readonly error: z.ZodError }

/** Discriminated result of validating a whole registry file. Never throws. */
export type ParseRegistryResult =
  | { readonly ok: true; readonly registry: RegistryFile }
  | { readonly ok: false; readonly error: z.ZodError }

/** Validates a raw, untrusted server record (CLI input, store contents). */
export function parseServerRecord(value: unknown): ParseServerRecordResult {
  const reserved = rejectReservedKeys(value)
  if (reserved !== null) {
    return { ok: false, error: reserved }
  }
  const result = serverRecordSchema.safeParse(value)
  return result.success ? { ok: true, record: result.data } : { ok: false, error: result.error }
}

/** Validates a raw, untrusted registry document (parsed JSON from disk). */
export function parseRegistry(value: unknown): ParseRegistryResult {
  const reserved = rejectReservedKeys(value)
  if (reserved !== null) {
    return { ok: false, error: reserved }
  }
  const result = registryFileSchema.safeParse(value)
  return result.success ? { ok: true, registry: result.data } : { ok: false, error: result.error }
}

/**
 * Pre-scan for reserved own-keys anywhere in the raw input. Required because
 * `JSON.parse` materializes `__proto__` as an own property but zod's record
 * rebuild silently drops it BEFORE any `superRefine` can see it (same
 * fail-open shape documented in `policy/schema.ts`, whose scanner is private
 * to that module — deliberately re-implemented here rather than widening the
 * policy module's public surface from a registry task).
 */
function rejectReservedKeys(value: unknown): z.ZodError | null {
  const path = findReservedKeyPath(value, [])
  if (path === null) {
    return null
  }
  return new z.ZodError([
    { code: 'custom', message: `reserved key "${String(path.at(-1))}" is not allowed`, path },
  ])
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
