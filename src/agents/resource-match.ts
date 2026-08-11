/**
 * Normalized, fail-closed matching of resource URIs against grant patterns
 * (security fix, M4 wave-1 review). The tool matcher (`policy/match.ts`) is
 * LEXICAL — exact name or `startsWith` prefix — which is right for tool names
 * but exploitable for URIs: `file:///project/../../etc/passwd` and
 * `file:///project/%2e%2e/secret` both start with `file:///project/` as
 * strings while naming resources far outside it, and `file:///project*`
 * lexically covers `file:///project-evil`.
 *
 * Both the granted patterns and the requested URI therefore go through ONE
 * canonicalization before comparison:
 *
 *  1. WHATWG `URL` parse — lowercases scheme and host, drops default ports,
 *     collapses `.`/`..` path segments including their percent-encoded forms.
 *  2. ONE percent-decode per path segment. A segment that decodes to `.`/`..`
 *     or grows a `/`/`\` (an encoded separator smuggling traversal past step 1)
 *     makes the whole URI unparseable.
 *  3. Anything unparseable — invalid URI, malformed percent-encoding, a dot
 *     segment surviving normalization (opaque paths) — is `null`, and `null`
 *     is DENIED. Fail closed, never lexical fallback.
 *
 * A trailing-`*` pattern matches only on a path-segment boundary: the prefix
 * itself, or the prefix followed by `/`-separated descendants. The absent /
 * empty grant is not this module's concern — `agents/scope.ts` resolves those
 * to "deny everything" before a matcher is ever built (M3 default, untouched).
 */

/** One compiled grant pattern: an exact canonical URI, or a segment-bounded prefix. */
type CompiledPattern =
  | { readonly kind: 'exact'; readonly value: string }
  | { readonly kind: 'prefix'; readonly exact: string; readonly withSlash: string }

/**
 * Canonical form of a resource URI, or `null` for anything that cannot be
 * positively normalized (the caller must treat `null` as "not granted").
 */
export function normalizeResourceUri(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  const decodedPath = decodePathOnce(url.pathname)
  if (decodedPath === null) return null

  const isOpaquePath = url.host === '' && !url.pathname.startsWith('/')
  if (isOpaquePath) {
    return `${url.protocol}${decodedPath}${url.search}${url.hash}`
  }
  return `${url.protocol}//${url.host}${decodedPath}${url.search}${url.hash}`
}

/**
 * Decodes each `/`-separated segment of a path exactly once. `null` when a
 * segment has malformed percent-encoding, decodes to a dot segment (the URL
 * parser only collapses those in hierarchical paths — an opaque path could
 * still carry one), or decodes to something containing a separator.
 */
function decodePathOnce(pathname: string): string | null {
  const decodedSegments: string[] = []
  for (const segment of pathname.split('/')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (decoded === '.' || decoded === '..') return null
    if (decoded.includes('/') || decoded.includes('\\')) return null
    decodedSegments.push(decoded)
  }
  return decodedSegments.join('/')
}

/** Compiles one pattern; `null` for a pattern that cannot grant anything safely. */
function compilePattern(pattern: string): CompiledPattern | null {
  if (!pattern.endsWith('*')) {
    const value = normalizeResourceUri(pattern)
    return value === null ? null : { kind: 'exact', value }
  }
  const base = normalizeResourceUri(pattern.slice(0, -1))
  if (base === null) return null
  const exact = base.endsWith('/') ? base.slice(0, -1) : base
  return { kind: 'prefix', exact, withSlash: `${exact}/` }
}

/**
 * Builds the membership predicate for one resource grant's pattern list.
 * Patterns that fail to compile grant nothing; a URI that fails to normalize
 * is never granted.
 */
export function resourceUriMatcher(patterns: readonly string[]): (uri: string) => boolean {
  const compiled = patterns
    .map(compilePattern)
    .filter((entry): entry is CompiledPattern => entry !== null)

  return (uri) => {
    const normalized = normalizeResourceUri(uri)
    if (normalized === null) return false
    return compiled.some((entry) =>
      entry.kind === 'exact'
        ? normalized === entry.value
        : normalized === entry.exact || normalized.startsWith(entry.withSlash),
    )
  }
}
