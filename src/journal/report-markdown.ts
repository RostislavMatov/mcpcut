import { formatReadableField } from './format.js'

/**
 * The two escapes every untrusted value in `summary.md` goes through, shared
 * by every renderer that writes into it (`report-summary.ts`,
 * `report-summary-pools.ts`). One module rather than a copy per renderer: two
 * sections of the same delivered document escaping differently is exactly the
 * drift that let a hostile tool name render live in the wave-5 review.
 *
 * EVERYTHING RENDERED THROUGH THESE IS UNTRUSTED. Every string was read back
 * out of the journal, which means it came from a proxied MCP server, an
 * approval an operator typed, or a hand-edited/forged row on disk. Two
 * separate escapes are therefore applied to every value, in order:
 * - `formatReadableField` (`format.ts`) -- the same pass the CLI's readable
 *   view uses: C0/DEL control characters become `?` and the field is length
 *   capped. A `doc` can carry a raw ESC, and `summary.md` gets `cat`ed on a
 *   terminal by the first auditor who opens it.
 * - `escapeMarkdown` -- the markup channels. A `|` inside a value would end
 *   its table cell early and let one journal string forge extra columns; and
 *   `summary.md` is not a plain-text file in practice -- it is handed to a
 *   third party who opens it in GitHub, VS Code, pandoc or a GRC portal,
 *   every one of which renders raw HTML and links from Markdown. The wave-5
 *   review confirmed a tool name of
 *   `<img src=x onerror=alert(1)> [click](javascript:alert(2))` rendering
 *   LIVE in the delivered document, because only `|` was escaped.
 *
 * Neither escape is optional and neither substitutes for the other; the
 * helpers below apply both, always together and in this order, so no call
 * site can pick just one.
 */

/**
 * The fallback for a field whose absence carries no meaning of its own --
 * it simply was not there. Every value a renderer did not personally
 * validate is treated as possibly absent and rendered with a marker: a
 * summary that crashes on a field the READER never required is a journal
 * that cannot be exported at all (wave-5 review, HIGH).
 */
export const ABSENT_VALUE = '(absent)'

/**
 * One table cell: the absent marker when there is no value, otherwise control
 * characters neutralized first (`formatReadableField`), then the markup
 * escaped. Order matters -- escaping first and sanitizing after would let the
 * sanitizer's own replacement character run back over an escape.
 *
 * The marker is NOT escaped: it is this codebase's own text, and escaping it
 * would print `\(absent\)` to an auditor.
 */
export function markdownCell(value: string | undefined, absent: string): string {
  return typeof value === 'string' ? escapeMarkdown(formatReadableField(value)) : absent
}

/** An inline (non-table) value: untrusted like every other, so sanitized and escaped the same way. */
export function inlineValue(value: string): string {
  return typeof value === 'string' ? escapeMarkdown(formatReadableField(value)) : ABSENT_VALUE
}

/**
 * Every character that opens a markup channel in the renderers this document
 * is actually read in, backslash-escaped in ONE pass (a per-character chain
 * would have to get its own ordering right, and would double-escape the
 * escapes it just added):
 * - `\\` itself, first by being in the class rather than by being applied
 *   first, so an escape cannot be forged out of a journal string;
 * - `<` `>` `&` -- raw HTML and entities. GitHub, VS Code and pandoc all
 *   render these, which is how `<img src=x onerror=...>` reached a delivered
 *   report in the review;
 * - `[` `]` `!` -- links and images, including `javascript:` targets;
 * - `` ` `` `*` `_` -- code spans and emphasis, which can hide or restyle
 *   text an auditor is reading as evidence;
 * - `|` -- the table delimiter: a cell that ends early forges extra columns,
 *   i.e. puts words in the report that the journal never held.
 *
 * All of these are ASCII punctuation, which CommonMark defines as
 * backslash-escapable, so the rendered text is the original string exactly.
 */
const MARKDOWN_SPECIAL_PATTERN = /[\\`*_[\]<>&|!]/g

export function escapeMarkdown(value: string): string {
  return value.replace(MARKDOWN_SPECIAL_PATTERN, '\\$&')
}
