import type { ClassifiedMessage } from '../protocol/classify.js'
import type { ToolDescriptor } from '../protocol/mcp.js'

/**
 * Filtering hygiene for a `tools/list` response: rewrites `result.tools` to
 * only the entries `isVisible` accepts, leaving every other field of the
 * message — and of `result` (`nextCursor`, `_meta`, anything else) —
 * untouched.
 *
 * Parses `original.raw` and filters the parsed `result.tools` array
 * in place, rather than going through `parseToolsListResult` /
 * `serializeToolsListResult`'s normalized `ToolDescriptor`. That direct
 * approach is deliberate: it preserves unknown/vendor fields on kept tool
 * entries verbatim, which round-tripping through the normalized descriptor
 * shape would silently drop.
 *
 * Filtering is hygiene, not enforcement — a policy decision still gates the
 * call itself. So any response shape this proxy doesn't understand (no
 * `result.tools` array, unparseable JSON) yields `null`, and the caller is
 * expected to forward the original message unchanged rather than treat a
 * parse failure as "no tools".
 */
export interface FilteredToolsListResult {
  readonly bytes: Buffer
  readonly removed: readonly string[]
  readonly kept: number
}

export function filterToolsListResult(
  original: ClassifiedMessage,
  isVisible: (tool: ToolDescriptor) => boolean,
): FilteredToolsListResult | null {
  const parsed = tryParseJsonObject(original.raw)
  if (!parsed) {
    return null
  }

  const result = parsed['result']
  if (!isPlainObject(result)) {
    return null
  }

  const rawTools = result['tools']
  if (!Array.isArray(rawTools)) {
    return null
  }

  const removed: string[] = []
  const filteredTools = rawTools.filter((entry) => shouldKeep(entry, isVisible, removed))

  const updated = {
    ...parsed,
    result: {
      ...result,
      tools: filteredTools,
    },
  }

  const serialized = JSON.stringify(updated)
  if (serialized.includes('\n')) {
    return null
  }

  return {
    bytes: Buffer.from(`${serialized}\n`, 'utf8'),
    removed,
    kept: filteredTools.length,
  }
}

/**
 * Decides whether one raw `tools/list` entry survives filtering, recording
 * its name in `removed` if not. An entry that isn't a named tool object is
 * kept unconditionally rather than dropped — this proxy doesn't understand
 * it well enough to judge visibility, and hygiene filtering must fail open
 * on the unknown rather than silently discard it.
 */
function shouldKeep(
  entry: unknown,
  isVisible: (tool: ToolDescriptor) => boolean,
  removed: string[],
): boolean {
  if (!isPlainObject(entry) || typeof entry['name'] !== 'string') {
    return true
  }

  const visible = isVisible(entry as unknown as ToolDescriptor)
  if (!visible) {
    removed.push(entry['name'])
  }
  return visible
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw)
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
