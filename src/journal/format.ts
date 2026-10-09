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

/**
 * C0 control characters, DEL and the C1 range (0x80-0x9f): none is safe to
 * print to a terminal raw. C1 matters as much as ESC — xterm and its kin honour
 * the 8-bit CSI (0x9b) and OSC (0x9d) exactly like their ESC-prefixed forms,
 * and they arrive as ordinary UTF-8 text (`src/tui/ansi.ts` strips the same
 * range for the console; `mcpcut logs` prints a daemon's log through here).
 *
 * Plus the invisible characters that change how text READS without moving
 * the cursor (0.2.3 review, Trojan Source class): bidi marks and overrides
 * (U+061C, U+200E-200F, U+202A-202E, U+2066-2069), zero-width characters
 * (U+200B-200D, U+2060, U+FEFF) and the line/paragraph separators (U+2028-2029);
 * and the ones that print as nothing at all (2026-10-02 security review): the
 * soft hyphen U+00AD, the grapheme joiner U+034F, the Hangul fillers U+115F,
 * U+1160, U+3164, U+FFA0, and the tag characters U+E0000-E007F.
 * A tool name the agent's side chose is printed on the line an operator
 * approves from; it must read as exactly what it is.
 */
const CONTROL_CHAR_PATTERN =
  /[\x00-\x1f\x7f-\x9f\u00ad\u034f\u061c\u115f\u1160\u200b-\u200f\u2028-\u202e\u2060-\u2069\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]/gu

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
  return truncate(replaceControlChars(value), MAX_READABLE_FIELD_CHARS)
}

/** The control-character half of `formatReadableField`, uncapped: for a value that must stay whole, such as a path in a command to paste. */
export function replaceControlChars(value: string): string {
  return value.replace(CONTROL_CHAR_PATTERN, CONTROL_CHAR_REPLACEMENT)
}

/** Removes every character `replaceControlChars` would mark, for a value stored rather than printed (a client's cancel reason). */
export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHAR_PATTERN, '')
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}${TRUNCATION_MARKER}` : text
}

/**
 * The subset of a decision record's fields the readable view renders.
 * Deliberately narrower than `DecisionInfo` (`journal/record.ts`) so this
 * module does not need to import it just to describe three strings.
 */
export interface DecisionSummaryFields {
  readonly outcome: string
  readonly toolName: string
  readonly rule: string
  /** Why the agent left, or why its session ended (M36); printed only when present. */
  readonly reason?: string
}

/**
 * Renders the readable-view summary for a `decision` journal record.
 * `outcome`/`toolName`/`rule` are read back from a journal file on disk --
 * untrusted, like every other readable-view field -- so each one goes
 * through `formatReadableField` before it reaches the terminal.
 */
export function formatDecisionSummary(decision: DecisionSummaryFields): string {
  const outcome = formatReadableField(decision.outcome)
  const tool = formatReadableField(decision.toolName)
  const rule = formatReadableField(decision.rule)
  const reason = decision.reason !== undefined ? ` reason=${formatReadableField(decision.reason)}` : ''
  return `outcome=${outcome} tool=${tool} rule=${rule}${reason}`
}
