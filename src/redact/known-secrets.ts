import { REDACTED_PLACEHOLDER } from '../config.js'

/**
 * Known-secret redaction: exact-value scrubbing for credential material the
 * control plane ITSELF handed to an upstream (vault-resolved env values, HTTP
 * header values, and the literals declared next to them in the registry).
 *
 * Why this exists next to the pattern redactor: patterns can only catch
 * secrets with a recognisable shape (`sk-…`, a PEM block, a `"password":`
 * key). A vault value is frequently a bare high-entropy string, and a server
 * that echoes it back on stderr or inside `result.content[].text` under an
 * innocent key ("note", "message") would otherwise land in the journal in
 * plaintext — the one leak the compliance story cannot afford, since the
 * plane injected that value in the first place.
 *
 * This is NOT a parallel persistence path: the scrubbing runs inside the
 * redact layer (`redact.ts`), on every string leaf of every carrier, before
 * the pattern pass. `redact()` remains the only way to a journal record.
 *
 * Registry LITERALS are registered too, deliberately. An operator who wrote a
 * value inline rather than as `vault:<name>` did not thereby declare it
 * public, and hiding a non-secret literal from the journal costs nothing.
 */

/**
 * Values shorter than this are never registered. A short string ("dev",
 * "8080", "true") occurs in unrelated text constantly, so registering one
 * would blank out legitimate journal content while protecting nothing worth
 * protecting — no credential of any consequence is under 8 characters.
 */
export const MIN_KNOWN_SECRET_CHARS = 8

/**
 * Prepares raw values for scrubbing: drops the too-short ones, deduplicates,
 * and orders longest-first so that when one registered value contains
 * another, the longer one is replaced whole instead of being left as a
 * partially-blanked fragment. The result is frozen — a registered set is
 * replaced, never mutated.
 */
export function normalizeKnownSecrets(values: Iterable<string>): readonly string[] {
  const unique = new Set<string>()
  for (const value of values) {
    if (value.length >= MIN_KNOWN_SECRET_CHARS) unique.add(value)
  }
  return Object.freeze([...unique].sort(byLengthThenValue))
}

function byLengthThenValue(a: string, b: string): number {
  if (a.length !== b.length) return b.length - a.length
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Replaces every occurrence of every registered value with the placeholder.
 * `split`/`join` rather than a regex: a secret is arbitrary text and must be
 * matched literally, with no escaping step to get wrong.
 */
export function scrubKnownSecrets(text: string, secrets: readonly string[]): string {
  if (secrets.length === 0) return text
  return secrets.reduce(
    (current, secret) =>
      current.includes(secret) ? current.split(secret).join(REDACTED_PLACEHOLDER) : current,
    text,
  )
}
