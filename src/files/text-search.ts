/**
 * Exact substring search in linear time (Knuth–Morris–Pratt over UTF-16 code
 * units). `String.prototype.indexOf` in V8 is not linear in the worst case: a
 * 64 KiB `oldText` of `a…ab a…a` against 10 MiB of `a` takes about two minutes
 * on one call, and `edit_file` runs on the event loop every session of
 * `serve` shares. This one is bounded by text plus needle length, whatever
 * the agent sends.
 */

function failureTable(needle: string): Int32Array {
  const table = new Int32Array(needle.length)
  let matched = 0
  for (let index = 1; index < needle.length; index += 1) {
    while (matched > 0 && needle.charCodeAt(index) !== needle.charCodeAt(matched)) matched = table[matched - 1] ?? 0
    if (needle.charCodeAt(index) === needle.charCodeAt(matched)) matched += 1
    table[index] = matched
  }
  return table
}

/** The first `limit` starts of `needle` in `text`, in order, overlapping ones included. */
export function findAtMost(text: string, needle: string, limit: number): readonly number[] {
  if (needle === '') throw new Error('findAtMost: the needle is empty')
  const table = failureTable(needle)
  const found: number[] = []
  let matched = 0
  for (let index = 0; index < text.length && found.length < limit; index += 1) {
    const code = text.charCodeAt(index)
    while (matched > 0 && code !== needle.charCodeAt(matched)) matched = table[matched - 1] ?? 0
    if (code === needle.charCodeAt(matched)) matched += 1
    if (matched === needle.length) {
      found.push(index - needle.length + 1)
      matched = table[matched - 1] ?? 0
    }
  }
  return found
}
