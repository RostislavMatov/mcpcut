import { lexicalKey, pathModuleOf } from '../names.js'

/**
 * The key a path is indexed and searched under: normalized (`..`, doubled and
 * trailing separators gone), then folded where the platform's volumes fold.
 * One function for the ingest and the query, so the two always agree.
 */
export function pathMatchKey(value: string, platform: NodeJS.Platform): string {
  const paths = pathModuleOf(platform)
  const normalized = paths.normalize(value)
  const root = paths.parse(normalized).root
  const trimmed = normalized.length > root.length ? normalized.replace(/[\\/]+$/, '') : normalized
  return lexicalKey(trimmed.length < root.length ? root : trimmed, platform)
}

/** Every folder key from the path itself up to the root — what a whole-tree action on a parent matches. */
export function ancestorKeys(key: string, platform: NodeJS.Platform): readonly string[] {
  const paths = pathModuleOf(platform)
  const keys: string[] = []
  let current = key
  for (;;) {
    keys.push(current)
    const parent = paths.dirname(current)
    if (parent === current) return keys
    current = parent
  }
}

/** The range of keys strictly inside `key`: `>= prefix` and `< end` under the "C" collation. */
export function descendantRange(key: string, platform: NodeJS.Platform): { readonly from: string; readonly to: string } {
  const sep = pathModuleOf(platform).sep
  const base = key.endsWith(sep) ? key.slice(0, -1) : key
  return { from: `${base}${sep}`, to: `${base}${String.fromCharCode(sep.charCodeAt(0) + 1)}` }
}

/** The indexed part of a key: 600 code points are at most 2400 bytes, under the btree row limit of 2704. */
export const KEY_PREFIX_CODE_POINTS = 600

export function keyPrefix(key: string): string {
  return Array.from(key).slice(0, KEY_PREFIX_CODE_POINTS).join('')
}

export function fitsKeyPrefix(value: string): boolean {
  return Array.from(value).length <= KEY_PREFIX_CODE_POINTS
}
