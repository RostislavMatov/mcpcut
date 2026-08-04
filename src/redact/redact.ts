import {
  REDACTED_PLACEHOLDER,
  REDACT_KEY_PATTERNS,
  REDACT_VALUE_PATTERNS,
} from '../config.js'

/** Marker written in place of a value that would otherwise create infinite recursion. */
const CIRCULAR_MARKER = '[CIRCULAR]'

/** True when an object key must be fully redacted regardless of its value. */
function isSensitiveKey(key: string): boolean {
  const lowerKey = key.toLowerCase()
  return REDACT_KEY_PATTERNS.some((pattern) => lowerKey.includes(pattern.toLowerCase()))
}

/**
 * Replaces every REDACT_VALUE_PATTERNS match inside a string.
 * Global regexes carry mutable lastIndex state, so each pattern is cloned
 * before use to avoid cross-call / cross-value statefulness bugs.
 */
function redactStringValue(value: string): string {
  return REDACT_VALUE_PATTERNS.reduce((current, pattern) => {
    const statelessPattern = new RegExp(pattern.source, pattern.flags)
    return current.replace(statelessPattern, REDACTED_PLACEHOLDER)
  }, value)
}

/** Redacts an array in place of recursion, tracking ancestors to break cycles. */
function redactArray(input: readonly unknown[], seen: WeakSet<object>): unknown {
  if (seen.has(input)) return CIRCULAR_MARKER
  seen.add(input as unknown as object)
  const result = input.map((item) => redactAny(item, seen))
  seen.delete(input as unknown as object)
  return result
}

/** Redacts an object's entries, tracking ancestors to break cycles. */
function redactObject(input: Readonly<Record<string, unknown>>, seen: WeakSet<object>): unknown {
  if (seen.has(input)) return CIRCULAR_MARKER
  seen.add(input)
  const entries = Object.entries(input).map(([key, value]) => [
    key,
    isSensitiveKey(key) ? REDACTED_PLACEHOLDER : redactAny(value, seen),
  ])
  seen.delete(input)
  return Object.fromEntries(entries)
}

/** Dispatches redaction by runtime type. Primitives, null and undefined pass through. */
function redactAny(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactStringValue(value)
  if (Array.isArray(value)) return redactArray(value, seen)
  if (value !== null && typeof value === 'object') {
    return redactObject(value as Record<string, unknown>, seen)
  }
  return value
}

/**
 * Returns a new, deeply redacted copy of `value`. Never mutates the input.
 * This is the only path a parsed JSON-RPC payload takes before journaling,
 * so every object key matching REDACT_KEY_PATTERNS and every string
 * substring matching REDACT_VALUE_PATTERNS must be stripped before return.
 */
export function redact(value: unknown): unknown {
  return redactAny(value, new WeakSet<object>())
}
