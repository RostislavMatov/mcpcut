/**
 * The indexer's second pass over text, after the journal's redaction: the
 * journal's rules are tuned to tokens it knows by shape, a config file also
 * holds `password: …` lines and bare random strings. Over-masking costs a
 * snippet some words; under-masking puts a secret in an agent's answer.
 *
 * Every pattern is linear: no nested quantifiers, every gap bounded, and a
 * match always consumes what it scanned (to the closing quote or the line
 * end), so no position is scanned twice.
 */

const MASK = '[REDACTED]'

/**
 * `<key containing a secret word><separators>[:=]<value>`; the key part is
 * bounded (a keyword plus at most 40 name characters) and starts at the
 * keyword, so a long run of name characters is never rescanned from each start.
 */
const KEY_VALUE =
  /((?:password|passwd|secret|token|api[_.-]?key|apikey|access[_.-]?key|private[_.-]?key|credential)[\w.-]{0,40}["']?[ \t]{0,20}[:=][ \t]{0,20})("[^"\n]*"|'[^'\n]*'|[^\n]+)/gi

/** Both quoted forms keep their quotes; an open quote or no quote goes to the end of the line. */
function maskValue(prefix: string, value: string): string {
  const quote = value[0]
  const isQuoted = (quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)
  return isQuoted ? `${prefix}${quote}${MASK}${quote}` : `${prefix}${MASK}`
}

/** Candidate runs of the characters hex, base64 and base64url are made of. */
const TOKEN_RUN = /[A-Za-z0-9+/_-]{32,}/g
const HEX_ONLY = /^[0-9A-Fa-f]+$/
const HEX_MIN_CHARS = 32
const BASE64_MIN_CHARS = 40

function isHighEntropy(run: string): boolean {
  if (!/[A-Za-z]/.test(run) || !/\d/.test(run)) return false
  return HEX_ONLY.test(run) ? run.length >= HEX_MIN_CHARS : run.length >= BASE64_MIN_CHARS
}

export function maskSecrets(text: string): string {
  return text
    .replace(KEY_VALUE, (_match, prefix: string, value: string) => maskValue(prefix, value))
    .replace(TOKEN_RUN, (run) => (isHighEntropy(run) ? MASK : run))
}
