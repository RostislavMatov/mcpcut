/**
 * The two JSON shape guards every rewriting module in `src/pool/*` needs.
 * Private to this directory, mirroring how `proxy/tools-filter.ts` and
 * `agents/method-grants.ts` each keep their own copies rather than sharing a
 * repository-wide utility module.
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function tryParseObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw)
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}
