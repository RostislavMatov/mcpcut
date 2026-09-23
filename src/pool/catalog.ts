import { PROMPTS_LIST_METHOD, TOOLS_LIST_METHOD } from '../protocol/mcp.js'
import type { SynthesizableId } from '../proxy/synthesize.js'
import type { PoolChildren } from './children.js'
import type { PoolFanout } from './fanout.js'
import {
  mergePoolList,
  readListPage,
  type MergedPoolList,
  type PoolListKind,
  type PoolListPart,
} from './merge-lists.js'

/**
 * Fan-out of one list request across every live child, and the merge of what
 * came back (ADR-0015 §7).
 *
 * The shape of every failure here is the same, and it is PE6 restated at the
 * catalog level: a server that did not answer contributes nothing, and the
 * agent still gets a list. Refusing the whole catalog because one upstream is
 * slow would hand a hostile — or merely overloaded — server a way to blind an
 * agent to every other server it was granted.
 *
 * Pages are drained here rather than passed through, because the merged
 * result carries no `nextCursor`: there is no single upstream cursor a pool
 * could hand out, so a cursor would be a promise this layer cannot keep.
 */

export interface PoolCatalogDeps {
  /** Asks one upstream one thing, bounded in time (`fanout.ts`). */
  readonly fanout: PoolFanout
  readonly children: PoolChildren
  /** Pages of one upstream drained before giving up on the rest. */
  readonly maxPages: number
}

export interface PoolCatalog {
  /**
   * Builds the merged catalog for one agent request. `null` only when the
   * merged line would break framing — see `mergePoolList`.
   */
  build(id: SynthesizableId, kind: PoolListKind): Promise<MergedPoolList | null>
}

/** The JSON-RPC method that lists one kind. */
const LIST_METHOD: Readonly<Record<PoolListKind, string>> = {
  tools: TOOLS_LIST_METHOD,
  prompts: PROMPTS_LIST_METHOD,
}

export function createPoolCatalog(deps: PoolCatalogDeps): PoolCatalog {
  /** Drains one upstream's pages; whatever it managed to say before failing. */
  async function drain(server: string, kind: PoolListKind): Promise<PoolListPart> {
    const entries: unknown[] = []
    let cursor: string | null = null

    for (let page = 0; page < deps.maxPages; page += 1) {
      const child = deps.children.childOf(server)
      if (child === undefined) {
        break
      }
      const currentCursor = cursor
      const raw = await deps.fanout.ask(child, `list:${kind}`, (id) =>
        requestLine(id, kind, currentCursor),
      )
      if (raw === null) {
        break
      }

      // An error response, or any shape not positively recognised, means this
      // server contributed nothing further — never an empty catalog the caller
      // could mistake for a successful answer.
      const read = readListPage(raw, kind)
      if (read === null) {
        break
      }
      entries.push(...read.entries)
      cursor = read.nextCursor
      if (cursor === null) {
        break
      }
    }

    return { server, entries }
  }

  return Object.freeze({
    async build(id: SynthesizableId, kind: PoolListKind): Promise<MergedPoolList | null> {
      // Every server at once: one slow upstream must cost the agent its own
      // timeout, not the sum of everybody else's.
      const parts = await Promise.all(
        deps.children.servers().map((server) => drain(server, kind)),
      )
      return mergePoolList(id, kind, parts)
    },
  })
}

/** One list request line for a plane-minted id, with a cursor only if there is one. */
function requestLine(id: string, kind: PoolListKind, cursor: string | null): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: LIST_METHOD[kind],
    // Absent, not null: an upstream is entitled to refuse a cursor it never
    // issued, and the first page has none.
    params: cursor === null ? {} : { cursor },
  })
}
