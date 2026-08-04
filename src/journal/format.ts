/**
 * Terminal-safe formatting for journal fields that are printed to stdout in
 * the CLI's readable view. Journal content is untrusted input (traffic from
 * a proxied MCP server, or a hand-edited/forged journal file on disk), so it
 * must never reach a terminal raw: a C0/DEL control character can move the
 * cursor, clear the screen or hide output (terminal injection).
 *
 * The `--json` view is unaffected by this module -- it stays raw and
 * authoritative, and payloads there already go through `JSON.stringify`,
 * which escapes control characters on its own.
 */

/** C0 control characters plus DEL: never safe to print to a terminal raw. */
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/g

/** What an unsafe control character is replaced with. */
const CONTROL_CHAR_REPLACEMENT = '?'

/** Marker appended when a field is cut down to MAX_READABLE_FIELD_CHARS. */
const TRUNCATION_MARKER = '…'

/** Max characters kept for one readable-view field (method, direction, kind, ts, sessionId, ...). */
export const MAX_READABLE_FIELD_CHARS = 200

/**
 * Sanitizes and caps one field for the terminal-readable view: control
 * characters are replaced first, then the result is length-capped, so a long
 * run of control characters cannot be used to pad past the cap as noise.
 */
export function formatReadableField(value: string): string {
  const sanitized = value.replace(CONTROL_CHAR_PATTERN, CONTROL_CHAR_REPLACEMENT)
  return truncate(sanitized, MAX_READABLE_FIELD_CHARS)
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}${TRUNCATION_MARKER}` : text
}
