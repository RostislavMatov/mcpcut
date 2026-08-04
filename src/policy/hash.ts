import { createHash } from 'node:crypto'

/**
 * Canonical JSON serialization and hashing for tool schema fingerprints.
 *
 * The policy layer needs a stable byte representation of a tool's
 * `{name, description, inputSchema, annotations}` so it can detect "rug
 * pull" changes (a server silently redefining an already-approved tool).
 * `JSON.stringify` alone is insufficient because object key order is not
 * guaranteed to be stable across servers/SDK versions — this module sorts
 * object keys recursively so semantically identical descriptors always hash
 * the same way, while genuinely different descriptors (including array
 * order, which is significant) hash differently.
 */

/**
 * Recursion guard for `canonicalJson`. No legitimate MCP tool schema nests
 * this deep; this exists to fail loudly on cycles or pathological input
 * rather than overflow the call stack.
 */
const CANONICAL_JSON_MAX_DEPTH = 64

/** Raised when `canonicalJson` recurses past `CANONICAL_JSON_MAX_DEPTH`. */
export class CanonicalJsonDepthError extends Error {
  constructor(maxDepth: number) {
    super(`canonicalJson: value nesting exceeds max depth of ${maxDepth}`)
    this.name = 'CanonicalJsonDepthError'
  }
}

/**
 * Serializes `value` to JSON with object keys sorted lexicographically at
 * every nesting level. Arrays keep their original order (order is
 * meaningful there). Follows `JSON.stringify` semantics for everything
 * else: `undefined` object properties are omitted, `undefined` array items
 * become `null`, and non-JSON values (functions, symbols) are dropped the
 * same way `JSON.stringify` drops them. Unlike `JSON.stringify`, this
 * always returns a string: a top-level value that has no JSON
 * representation (`undefined`, a function, a symbol) serializes to `"null"`
 * rather than to `undefined`, since there is no enclosing property to omit
 * it from.
 */
export function canonicalJson(value: unknown): string {
  return stringifyCanonical(value, 0) ?? 'null'
}

function stringifyCanonical(value: unknown, depth: number): string | undefined {
  if (depth > CANONICAL_JSON_MAX_DEPTH) {
    throw new CanonicalJsonDepthError(CANONICAL_JSON_MAX_DEPTH)
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return stringifyArray(value, depth)
  }
  return stringifyObject(value as Record<string, unknown>, depth)
}

function stringifyArray(items: readonly unknown[], depth: number): string {
  const serializedItems = items.map((item) => stringifyCanonical(item, depth + 1) ?? 'null')
  return `[${serializedItems.join(',')}]`
}

function stringifyObject(obj: Record<string, unknown>, depth: number): string {
  const entries = Object.keys(obj)
    .sort()
    .map((key) => {
      const serializedValue = stringifyCanonical(obj[key], depth + 1)
      return serializedValue === undefined ? undefined : `${JSON.stringify(key)}:${serializedValue}`
    })
    .filter((entry): entry is string => entry !== undefined)
  return `{${entries.join(',')}}`
}

/** Lowercase hex-encoded SHA-256 digest of `text` (UTF-8). */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The subset of an MCP tool descriptor that determines its behavior. Kept
 * intentionally minimal and independent of any SDK type so this module has
 * no dependency on `src/policy/schema.ts` (owned by a parallel task).
 */
export interface ToolSchemaDescriptor {
  readonly name: string
  readonly description?: string | undefined
  readonly inputSchema?: unknown
  readonly annotations?: unknown
}

/**
 * Fingerprint of a tool's advertised shape. `description` is deliberately
 * included: a server that only edits the description of an
 * already-approved tool must still be treated as "changed" (rug-pull
 * defense), not silently re-approved because the input schema is unchanged.
 * Missing fields are normalized to `null` so "field omitted" and "field
 * explicitly null" hash identically, while "field present with a value"
 * always hashes differently from both.
 */
export function hashToolSchema(descriptor: ToolSchemaDescriptor): string {
  return sha256Hex(
    canonicalJson({
      name: descriptor.name,
      description: descriptor.description ?? null,
      inputSchema: descriptor.inputSchema ?? null,
      annotations: descriptor.annotations ?? null,
    }),
  )
}
