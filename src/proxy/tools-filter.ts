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

/**
 * `isGrantedToAgent` is the optional agent dimension (M3): when provided,
 * a tool survives only as the intersection of what was granted to the agent
 * AND what M2 policy leaves visible. Omitting it is exactly the M2 (ad-hoc
 * `wrap`) behavior. Like `isVisible`, it is only ever consulted for entries
 * that are recognizably named tool objects — but unlike M2, an entry neither
 * predicate can read is DROPPED while the agent dimension is on (see
 * `shouldKeep`): hygiene may fail open, an allowlist may not.
 */
export function filterToolsListResult(
  original: ClassifiedMessage,
  isVisible: (tool: ToolDescriptor) => boolean,
  isGrantedToAgent?: (tool: string) => boolean,
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
  const filteredTools = rawTools.filter((entry) =>
    shouldKeep(entry, isVisible, isGrantedToAgent, removed),
  )

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
 * its name in `removed` if not. A named entry survives only the intersection:
 * granted to the agent (when an agent predicate is present) AND visible under
 * policy.
 *
 * An entry that isn't a named tool object splits the two modes:
 *  - **without** an agent predicate this is M2 hygiene, which fails OPEN — the
 *    proxy doesn't understand the entry well enough to judge its visibility,
 *    and hygiene must not silently discard what it cannot read;
 *  - **with** one it is an agent allowlist, which fails CLOSED — a nameless
 *    entry cannot be intersected with a grant, and an allowlist that admits
 *    what it could not check is not an allowlist. (It is also the exact shape
 *    a server would use to smuggle a tool past grant filtering.) It has no
 *    name to report, so it is dropped without a `removed` entry; the paired
 *    `toolsList.original`/`toolsList.filtered` journal records still show the
 *    difference in count.
 */
function shouldKeep(
  entry: unknown,
  isVisible: (tool: ToolDescriptor) => boolean,
  isGrantedToAgent: ((tool: string) => boolean) | undefined,
  removed: string[],
): boolean {
  if (!isPlainObject(entry) || typeof entry['name'] !== 'string') {
    return isGrantedToAgent === undefined
  }

  const granted = isGrantedToAgent === undefined || isGrantedToAgent(entry['name'])
  const visible = granted && isVisible(entry as unknown as ToolDescriptor)
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
