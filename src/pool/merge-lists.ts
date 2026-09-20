import { compareAsText } from '../agents/effective.js'
import type { SynthesizableId } from '../proxy/synthesize.js'
import {
  MAX_POOL_CATALOG_BYTES,
  MAX_POOL_ENTRIES_PER_SERVER,
  MAX_POOL_ENTRY_BYTES,
} from './constants.js'
import { isPlainObject, tryParseObject } from './json.js'
import { encodePoolName, poolNameFit } from './name-codec.js'

/**
 * Merging of `tools/list` / `prompts/list` pages from several upstream servers
 * into the single catalog a pooled agent sees (ADR-0015 §7).
 *
 * Entries are rewritten the direct way — parse, spread, re-serialize — rather
 * than round-tripping through a normalized descriptor, for the same reason
 * `proxy/tools-filter.ts` does it: vendor fields, `inputSchema` and
 * `annotations` on a kept entry must survive verbatim. Only `name` changes.
 *
 * Nothing here does IO or logging: everything an operator should learn about a
 * merge (hidden names, unreadable entries, a refused server) comes back as a
 * field of the result, the way `FilteredMethodList` reports `droppedUnreadable`.
 */

/** Which catalog is being merged; also the `result` field the entries live in. */
export type PoolListKind = 'tools' | 'prompts'

/** One page of one upstream's catalog. */
export interface PoolListPage {
  readonly entries: readonly unknown[]
  readonly nextCursor: string | null
}

/**
 * Reads ONE upstream list result line. `null` for any shape not positively
 * recognised (an error response, a missing array, unparseable bytes) — the
 * caller treats that as "this server contributed nothing", never as an empty
 * catalog it could mistake for a successful answer.
 */
export function readListPage(raw: string, kind: PoolListKind): PoolListPage | null {
  const parsed = tryParseObject(raw)
  if (parsed === null) return null

  const result = parsed['result']
  if (!isPlainObject(result)) return null

  const entries = result[kind]
  if (!Array.isArray(entries)) return null

  const cursor = result['nextCursor']
  return { entries, nextCursor: typeof cursor === 'string' ? cursor : null }
}

/** One upstream's fully drained catalog, ready to merge. */
export interface PoolListPart {
  readonly server: string
  readonly entries: readonly unknown[]
}

/** A name the merge could not list, or listed only with a warning. */
export interface HiddenPoolName {
  readonly server: string
  readonly name: string
}

export interface MergedPoolList {
  /** One JSON line, no trailing `\n` — framing belongs to the transport. */
  readonly serialized: string
  /** How many entries the agent will actually see. */
  readonly count: number
  /** Names too long for known clients, left out of the list (PE2 a). */
  readonly hidden: readonly HiddenPoolName[]
  /** Names listed, but past the warn threshold. */
  readonly warned: readonly HiddenPoolName[]
  /** Entries with no readable name, counted per server. */
  readonly droppedUnreadable: Readonly<Record<string, number>>
  /** Servers left out whole: a duplicate name, or a name that cannot be encoded. */
  readonly refusedServers: readonly string[]
  /** Entries left out for size — too many, too big, or past the catalog budget. */
  readonly droppedOversize: Readonly<Record<string, number>>
}

/**
 * Merges every part into one response. Servers are ordered by name and each
 * server's entries keep the order that server sent them, so two connections of
 * the same agent see byte-identical catalogs — the spec's "`tools/list` MUST
 * NOT vary per-connection".
 *
 * The result carries NO `nextCursor`: by the time a part reaches here its
 * upstream pages have all been drained by the caller, so a cursor would be a
 * promise this layer cannot keep.
 *
 * `null` only if the merged line would break framing. `JSON.stringify` escapes
 * a literal newline inside any string, so with today's callers that branch is
 * unreachable — it is kept, like the identical one in `proxy/tools-filter.ts`,
 * because the cost is one comparison and the alternative is a silently
 * corrupted frame the day some caller hands this a line it did not parse.
 */
export function mergePoolList(
  id: SynthesizableId,
  kind: PoolListKind,
  parts: readonly PoolListPart[],
): MergedPoolList | null {
  const merged: Record<string, unknown>[] = []
  const hidden: HiddenPoolName[] = []
  const warned: HiddenPoolName[] = []
  const droppedUnreadable: Record<string, number> = {}
  const droppedOversize: Record<string, number> = {}
  const refusedServers: string[] = []
  let budget = MAX_POOL_CATALOG_BYTES

  function dropOversize(server: string, howMany = 1): void {
    droppedOversize[server] = (droppedOversize[server] ?? 0) + howMany
  }

  const ordered = [...parts].sort((left, right) => compareAsText(left.server, right.server))
  for (const part of ordered) {
    const read = readPart(part)
    if (read === null) {
      refusedServers.push(part.server)
      continue
    }
    if (read.unreadable > 0) {
      droppedUnreadable[part.server] = read.unreadable
    }
    if (read.overCount > 0) {
      dropOversize(part.server, read.overCount)
    }
    for (const entry of read.entries) {
      const fit = poolNameFit(entry.poolName)
      if (fit === 'hidden') {
        hidden.push({ server: part.server, name: entry.name })
        continue
      }

      const rewritten = { ...entry.source, name: entry.poolName }
      // Measured once, here: an entry too big on its own, or one that no
      // longer fits the catalog's remaining budget, is dropped and counted —
      // the same "drop what you cannot take, and say how much" discipline as
      // `droppedUnreadable`, never a silently truncated list.
      const size = JSON.stringify(rewritten).length
      if (size > MAX_POOL_ENTRY_BYTES || size > budget) {
        dropOversize(part.server)
        continue
      }
      budget -= size

      if (fit === 'warn') {
        warned.push({ server: part.server, name: entry.name })
      }
      merged.push(rewritten)
    }
  }

  const serialized = JSON.stringify({ jsonrpc: '2.0', id, result: { [kind]: merged } })
  if (serialized.includes('\n')) return null

  return {
    serialized,
    count: merged.length,
    hidden,
    warned,
    droppedUnreadable,
    droppedOversize,
    refusedServers,
  }
}

/** One readable entry of one part, with the pool name it would be listed under. */
interface ReadEntry {
  readonly source: Record<string, unknown>
  readonly name: string
  readonly poolName: string
}

interface ReadPart {
  readonly entries: readonly ReadEntry[]
  readonly unreadable: number
  /** Entries past the per-server cap, counted rather than read. */
  readonly overCount: number
}

/**
 * Reads one part up front, so a duplicate found late still refuses the server
 * as a whole. `null` means the server is refused: it either listed one name
 * twice — and choosing silently between two identically named surfaces is
 * exactly the substitution quarantine exists to prevent (ADR-0015 §6) — or its
 * own name cannot be encoded.
 */
function readPart(part: PoolListPart): ReadPart | null {
  const entries: ReadEntry[] = []
  const seen = new Set<string>()
  let unreadable = 0

  const readable = part.entries.slice(0, MAX_POOL_ENTRIES_PER_SERVER)
  const overCount = part.entries.length - readable.length

  for (const source of readable) {
    if (!isPlainObject(source) || typeof source['name'] !== 'string' || source['name'].length === 0) {
      unreadable += 1
      continue
    }
    const name = source['name']
    // Compared in NFC, listed as sent. Two spellings of one name render
    // identically, so treating them as different names would let a server
    // reintroduce exactly the ambiguity §6 refuses — while the entry itself
    // keeps its original bytes, because that is what has to be addressable.
    const key = name.normalize('NFC')
    if (seen.has(key)) return null
    seen.add(key)

    const poolName = encodePoolName(part.server, name)
    if (poolName === null) return null

    entries.push({ source, name, poolName })
  }

  return { entries, unreadable, overCount }
}
