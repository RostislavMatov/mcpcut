import {
  REDACTED_PLACEHOLDER,
  REDACT_KEY_PATTERNS,
  REDACT_KEY_TOKENS,
  REDACT_PARTIAL_VALUE_PATTERNS,
  REDACT_VALUE_PATTERNS,
} from '../config.js'

/**
 * Pattern-level redaction primitives shared by the structural redactor.
 *
 * These are the last line of defence for text the structural redactor cannot
 * walk: unparseable protocol lines, oversize framer flushes, stderr output.
 * For that text `redactText` applies the same *key* policy as the structural
 * pass by scrubbing `"key": value` pairs lexically, so a truncated JSON
 * fragment is redacted just like a parsed one.
 */

/** Splits a key into comparable tokens: `userPin` / `user_pin` -> [user, pin]. */
const CAMEL_CASE_BOUNDARY = /([a-z0-9])([A-Z])/g
const KEY_TOKEN_SEPARATOR = /[^a-z0-9]+/

/**
 * Matches a JSON-ish `"key": value` pair in raw text. The key is bounded and
 * the value alternatives are unambiguous (a quoted string with escapes, or a
 * bare token), keeping the match linear-time. The bare-token alternative
 * excludes structural characters so a non-sensitive key cannot swallow the
 * nested pair that follows it (`"params":{"password":"x"}`).
 */
const TEXT_KEY_VALUE_PATTERN =
  /"([A-Za-z0-9_.$-]{1,64})"(\s*:\s*)("(?:[^"\\]|\\.)*"|[^\s,{}[\]"']+)/g

/** A PEM header with no matching footer: the body runs to the end of the text. */
const UNTERMINATED_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g

/** True when an object key must be fully redacted regardless of its value. */
export function isSensitiveKey(key: string): boolean {
  const lowerKey = key.toLowerCase()
  if (REDACT_KEY_PATTERNS.some((pattern) => lowerKey.includes(pattern.toLowerCase()))) {
    return true
  }
  return keyTokens(key).some((token) => REDACT_KEY_TOKENS.includes(token))
}

/**
 * Scrubs every known secret shape out of a raw string: partial patterns first
 * (they keep non-secret context such as hosts and parameter names), then
 * whole-match value patterns, then a key-aware pass over `"key": value` pairs.
 *
 * Global regexes carry mutable lastIndex state, so each pattern is cloned
 * before use to avoid cross-call / cross-value statefulness bugs.
 */
export function redactText(value: string): string {
  const withPartials = REDACT_PARTIAL_VALUE_PATTERNS.reduce(
    (current, rule) => current.replace(clonePattern(rule.pattern), rule.replacement),
    value,
  )
  const withValues = REDACT_VALUE_PATTERNS.reduce(
    (current, pattern) => current.replace(clonePattern(pattern), REDACTED_PLACEHOLDER),
    withPartials,
  )
  return scrubKeyedValues(withValues)
}

/**
 * Blanks a PEM block that has a BEGIN marker but no END marker, along with
 * everything after it. Call this *after* `redactText` and after any size
 * capping: complete blocks are already gone by then, so a surviving BEGIN
 * marker means the block was cut short (by truncation or by the writer) and
 * its body would otherwise be journaled as plain base64.
 */
export function sealUnterminatedKeyBlock(text: string): string {
  return text.replace(clonePattern(UNTERMINATED_KEY_BLOCK_PATTERN), REDACTED_PLACEHOLDER)
}

/** Applies the sensitive-key policy lexically, for text that never parsed. */
function scrubKeyedValues(text: string): string {
  return text.replace(clonePattern(TEXT_KEY_VALUE_PATTERN), (match, key: string, separator: string) =>
    isSensitiveKey(key) ? `"${key}"${separator}"${REDACTED_PLACEHOLDER}"` : match,
  )
}

function keyTokens(key: string): readonly string[] {
  return key
    .replace(CAMEL_CASE_BOUNDARY, '$1 $2')
    .toLowerCase()
    .split(KEY_TOKEN_SEPARATOR)
    .filter((token) => token.length > 0)
}

function clonePattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags)
}
