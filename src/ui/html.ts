/**
 * Escaping-by-default HTML rendering for the admin UI. This module is the
 * ONLY sanctioned path from data to markup — the exact analogue of the
 * project's "redaction is the only path to persistence" invariant. Every
 * value interpolated into an `html` template is HTML-escaped unless it is
 * already an `Html` fragment built by this same module.
 *
 * Why this matters here specifically: the UI renders content the plane does
 * NOT control — MCP tool names, tool descriptions and call arguments come
 * from a proxied (untrusted) server, and journal payloads are read back off
 * disk where a forged file could carry anything. A single unescaped
 * interpolation is a stored/reflected XSS in a product whose whole job is to
 * guard other people's secrets. So the safe path is made the *default* and
 * the escape hatch (`raw`) is structurally incapable of accepting an
 * unverified string.
 *
 * Design note — runtime brand over pure type-level: TypeScript types are
 * erased at runtime, and the inputs here are untrusted (a JS caller, an
 * `as any` cast, or a homoglyph-laden string can all slip past the
 * compiler). `Html` is therefore a real class instance; `raw()`/`render()`/
 * `join()` verify the brand at runtime, so the guarantee survives type
 * erasure instead of merely documenting intent.
 */

/** HTML-significant characters and their entity replacements. */
const ESCAPE_PATTERN = /[&<>"']/g
const ESCAPE_REPLACEMENTS: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escapes the five characters that can break out of HTML text or a quoted
 * attribute. `&` is handled first (it heads the pattern) so an existing
 * entity like `&lt;` is neutralised to `&amp;lt;` rather than left decodable.
 */
export function escapeHtml(value: string): string {
  return value.replace(ESCAPE_PATTERN, (char) => ESCAPE_REPLACEMENTS[char] ?? char)
}

/**
 * An already-safe HTML fragment. The only ways to obtain one are the `html`
 * tagged template and `raw()` (which only re-wraps an existing `Html`), so a
 * value of this type is HTML that has already passed through escaping. The
 * wrapped string is private and read only via `render()` / `toString()`.
 */
export class Html {
  /** Brand: makes the class nominally unique and survives type erasure. */
  private readonly __safeHtml = true
  private readonly value: string

  constructor(value: string) {
    this.value = value
    void this.__safeHtml
  }

  toString(): string {
    return this.value
  }
}

/** True when `value` is an `Html` built by this module. */
export function isHtml(value: unknown): value is Html {
  return value instanceof Html
}

/**
 * Normalises one interpolated value to a safe HTML string:
 * - `Html`             → inserted verbatim (already escaped)
 * - `null`/`undefined` → empty string
 * - array              → each element normalised and concatenated
 * - anything else      → `String(value)` then escaped
 */
function normalize(value: unknown): string {
  if (value instanceof Html) {
    return value.toString()
  }
  if (value === null || value === undefined) {
    return ''
  }
  if (Array.isArray(value)) {
    return value.map(normalize).join('')
  }
  return escapeHtml(String(value))
}

/**
 * Escaping-by-default tagged template. Static template parts are trusted
 * (author-written); every `${...}` is normalised, so untrusted data cannot
 * introduce markup. Returns an `Html` — never a bare string — so downstream
 * code cannot accidentally treat rendered output as re-interpolable text.
 */
export function html(strings: TemplateStringsArray, ...values: readonly unknown[]): Html {
  let out = strings[0] ?? ''
  for (let i = 0; i < values.length; i += 1) {
    out += normalize(values[i]) + (strings[i + 1] ?? '')
  }
  return new Html(out)
}

/**
 * Unwraps an `Html` to its string form for an HTTP body. Refuses anything
 * not built by `html` so a stray string body cannot masquerade as rendered,
 * already-escaped output.
 */
export function render(node: Html): string {
  if (!(node instanceof Html)) {
    throw new TypeError('render() expects Html built by the html`` tag')
  }
  return node.toString()
}

/**
 * The checked escape hatch. It does NOT accept arbitrary strings: the only
 * thing it takes is an `Html` already built by this module, which it returns
 * unchanged. Its value is as an explicit, greppable marker at call sites plus
 * a runtime brand check that rejects a bare string forced through with a cast
 * or from JavaScript. There is deliberately no way to turn an untrusted
 * string into `Html` except by routing it through `html` (where it is
 * escaped).
 */
export function raw(node: Html): Html {
  if (!(node instanceof Html)) {
    throw new TypeError(
      'raw() only accepts Html built by the html`` tag; route untrusted strings through html``',
    )
  }
  return node
}

/**
 * Concatenates `Html` fragments with an `Html` separator (default: none).
 * Each item is brand-checked, so a bare string in the list is rejected rather
 * than silently escaped-or-injected.
 */
export function join(nodes: readonly Html[], separator: Html = new Html('')): Html {
  const parts = nodes.map((node) => render(node))
  return new Html(parts.join(render(separator)))
}

/**
 * URL schemes safe to place in an `href`/`src`. Everything else (notably
 * `javascript:`, `data:`, `vbscript:`) is dangerous because escaping alone
 * does not defuse it: `javascript:alert(1)` contains no HTML-significant
 * character, so a quoted-attribute escape leaves it fully executable.
 */
const SAFE_URL_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto'])

/**
 * Characters stripped before scheme detection: C0 controls, space, and the
 * unicode spaces / zero-width / BOM characters an attacker uses to smuggle a
 * scheme past a naive check (e.g. a zero-width space before `javascript:`).
 * Detection runs on the stripped copy; the original is returned when safe.
 */
const URL_IGNORE_PATTERN = new RegExp(
  '[\\u0000-\\u0020\\u00a0\\u1680\\u2000-\\u200f\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+',
  'g',
)

/** Matches a leading URL scheme (`scheme:`), per the URL grammar. */
const URL_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i

/**
 * Returns `value` when it is a safe URL, otherwise `'#'`. Relative URLs (no
 * scheme) are allowed; an absolute URL is allowed only if its scheme is in
 * the allowlist. The caller still interpolates the result through `html`, so
 * attribute-delimiter escaping is applied on top of this scheme check.
 */
export function safeUrl(value: string): string {
  const stripped = value.replace(URL_IGNORE_PATTERN, '')
  const match = URL_SCHEME_PATTERN.exec(stripped)
  if (!match) {
    return value // relative / fragment / query — no scheme to vet
  }
  const scheme = (match[1] ?? '').toLowerCase()
  return SAFE_URL_SCHEMES.has(scheme) ? value : '#'
}
