import { html, type Html } from './html.js'

/**
 * Display form of a name chosen by an UNTRUSTED party — today a tool name from
 * a registered MCP server's `tools/list` (security audit 2026-09-02, F1).
 *
 * The HTML escaper stops markup, not deception: a right-to-left override
 * (U+202E), a zero-width joiner or a Cyrillic `і` all survive escaping and
 * render as nothing, or as the Latin letter they imitate. The approval queue
 * is where a human decides on exactly such a name under a countdown, so what
 * is shown there must never be a disguised string.
 *
 * Two rules, one for each trick:
 *  - characters that render as nothing (`Default_Ignorable_Code_Point`,
 *    format characters `Cf` — bidi controls, zero-width, BOM, soft hyphen)
 *    are REMOVED for display, the same class `stripEvasionChars` in
 *    `policy/classify-tool.ts` removes before the destructive-tool heuristic;
 *  - anything left that is not printable ASCII (homoglyphs, combining marks)
 *    is kept — it may be a legitimate name — but the name is FLAGGED so the
 *    reader sees a mark next to it, never an unmarked look-alike.
 *
 * The raw name is untouched everywhere else: policy matching, the journal,
 * hidden form fields and URLs that round-trip a tool to a POST handler all
 * work on the exact bytes the server declared.
 */
const INVISIBLE_PATTERN = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu

/** Anything outside printable ASCII (space through tilde) flags the name. */
const NON_ASCII_PRINTABLE_PATTERN = /[^\x20-\x7e]/u

const FLAG_LABEL = 'non-standard characters in name'
const FLAG_TITLE = 'This name contains non-ASCII or invisible characters; invisible ones are not shown.'

export interface DisplayName {
  /** What to show: the raw name with every invisible code point removed. */
  readonly text: string
  /** True when something was removed or a non-ASCII character remains. */
  readonly isFlagged: boolean
}

/** Pure: never mutates its input, never throws. */
export function displayName(raw: string): DisplayName {
  const text = raw.replace(INVISIBLE_PATTERN, '')
  const isFlagged = text.length !== raw.length || NON_ASCII_PRINTABLE_PATTERN.test(text)
  return { text, isFlagged }
}

/**
 * The escaped display text, followed — only when flagged — by a visible,
 * explained warning badge. Attribute contexts (`title`, `data-*`, `<option>`)
 * cannot carry the badge: use `displayName(raw).text` there.
 */
export function renderToolName(raw: string): Html {
  const shown = displayName(raw)
  if (!shown.isFlagged) return html`${shown.text}`
  return html`${shown.text}<span class="name-flag" role="img" aria-label="${FLAG_LABEL}" title="${FLAG_TITLE}">⚠</span>`
}
