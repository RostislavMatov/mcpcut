import {
  MAX_EMBEDDED_JSON_CHARS,
  MAX_EMBEDDED_JSON_DEPTH,
  REDACTED_PLACEHOLDER,
} from '../config.js'
import { isSensitiveKey, redactText } from './patterns.js'

/** Marker written in place of a value that would otherwise create infinite recursion. */
const CIRCULAR_MARKER = '[CIRCULAR]'

/** Characters a string must start with before it is worth re-parsing as JSON. */
const JSON_OPENERS = ['{', '[']

interface RedactContext {
  /** Ancestors on the current path, used to break reference cycles. */
  readonly seen: WeakSet<object>
  /** How many embedded-JSON strings have been re-parsed on this path. */
  readonly jsonDepth: number
}

/**
 * Redacts a string value. A string that looks like JSON is re-parsed and run
 * through the structural redactor, because MCP routinely carries JSON inside
 * `result.content[0].text`; pattern scrubbing alone would miss the secret.
 * Anything else (and anything that fails to parse) falls through to pattern
 * and key-aware text scrubbing.
 */
function redactStringValue(value: string, ctx: RedactContext): string {
  return redactEmbeddedJson(value, ctx) ?? redactText(value)
}

/**
 * Returns the re-serialized, redacted form of an embedded JSON string, or
 * undefined when the string is not embedded JSON, is too large, is nested too
 * deeply, or contained nothing sensitive (in which case the caller keeps the
 * original text verbatim rather than reformatting it).
 */
function redactEmbeddedJson(value: string, ctx: RedactContext): string | undefined {
  if (ctx.jsonDepth >= MAX_EMBEDDED_JSON_DEPTH || value.length > MAX_EMBEDDED_JSON_CHARS) {
    return undefined
  }
  const trimmed = value.trim()
  if (!JSON_OPENERS.some((opener) => trimmed.startsWith(opener))) {
    return undefined
  }

  const parsed = tryParseJson(trimmed)
  if (!parsed.ok) {
    return undefined
  }

  const redacted = redactAny(parsed.value, { seen: ctx.seen, jsonDepth: ctx.jsonDepth + 1 })
  const serialized = JSON.stringify(redacted)
  return serialized === JSON.stringify(parsed.value) ? undefined : serialized
}

/** Redacts an array in place of recursion, tracking ancestors to break cycles. */
function redactArray(input: readonly unknown[], ctx: RedactContext): unknown {
  if (ctx.seen.has(input)) return CIRCULAR_MARKER
  ctx.seen.add(input as unknown as object)
  const result = input.map((item) => redactAny(item, ctx))
  ctx.seen.delete(input as unknown as object)
  return result
}

/** Redacts an object's entries, tracking ancestors to break cycles. */
function redactObject(input: Readonly<Record<string, unknown>>, ctx: RedactContext): unknown {
  if (ctx.seen.has(input)) return CIRCULAR_MARKER
  ctx.seen.add(input)
  const entries = Object.entries(input).map(([key, value]) => [
    key,
    isSensitiveKey(key) ? REDACTED_PLACEHOLDER : redactAny(value, ctx),
  ])
  ctx.seen.delete(input)
  return Object.fromEntries(entries)
}

/** Dispatches redaction by runtime type. Primitives, null and undefined pass through. */
function redactAny(value: unknown, ctx: RedactContext): unknown {
  if (typeof value === 'string') return redactStringValue(value, ctx)
  if (Array.isArray(value)) return redactArray(value, ctx)
  if (value !== null && typeof value === 'object') {
    return redactObject(value as Record<string, unknown>, ctx)
  }
  return value
}

function newContext(): RedactContext {
  return { seen: new WeakSet<object>(), jsonDepth: 0 }
}

/**
 * Returns a new, deeply redacted copy of `value`. Never mutates the input.
 * This is the only path a parsed JSON-RPC payload takes before journaling,
 * so every object key matching the key policy and every string substring
 * matching a value pattern must be stripped before return.
 */
export function redact(value: unknown): unknown {
  return redactAny(value, newContext())
}

/**
 * Redacts a raw, unparsed line (invalid protocol line, framer overflow,
 * stderr). Same policy as `redact`, but typed as string-in/string-out so
 * callers can size-cap the result without casting.
 */
export function redactString(value: string): string {
  return redactStringValue(value, newContext())
}

type ParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

function tryParseJson(raw: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}
