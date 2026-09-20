import type { JsonRpcId } from '../protocol/classify.js'
import { idKeyOf } from '../proxy/gate-helpers.js'
import type { SynthesizableId } from '../proxy/synthesize.js'
import { POOL_FANOUT_ID_PREFIX } from './constants.js'

/**
 * Correlation of replies at a pool address (ADR-0015 §3).
 *
 * Client ids are NOT rewritten — the agent has one id space and each of its
 * calls goes to exactly one upstream. What must be enforced instead is that a
 * reply can only settle the request it belongs to: an id in flight at server A
 * cannot be answered by server B. Without that check a hostile or merely buggy
 * upstream could answer somebody else's call, which is "one outcome per id"
 * broken in the most damaging way available.
 *
 * The plane's own requests to upstreams (fan-out `tools/list`, `initialize`)
 * live in a separate id space behind a reserved prefix, so they can neither
 * collide with a client id nor be forwarded to the agent by mistake.
 *
 * A bounded `Map` inside the closure, never handed out — the shape
 * `proxy/id-tracking.ts` uses for the gate's trackers.
 */

export type TrackOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'duplicate-id' | 'at-capacity' | 'reserved-id' }

export type SettleOutcome =
  /** The agent's own request: forward the reply. */
  | { readonly kind: 'client' }
  /** The plane's own request; `tag` says which. Never forwarded to the agent. */
  | { readonly kind: 'fanout'; readonly tag: string }
  /** Wrong server, unknown id, or no id at all: drop it and journal the drop. */
  | { readonly kind: 'unexpected' }

export interface PoolCorrelator {
  /** Records one agent request as in flight at `server`. */
  trackClient(id: SynthesizableId, server: string): TrackOutcome
  /**
   * Allocates an id in the plane's own namespace for a request it sends to
   * `server`. `null` at capacity — see the implementation for why fan-out is
   * capped alongside client requests rather than exempt from the cap.
   */
  trackFanout(server: string, tag: string): string | null
  /** Judges one reply arriving from `server`. */
  settle(server: string, id: JsonRpcId): SettleOutcome
  /** Which child holds this in-flight client id (routes `notifications/cancelled`). */
  serverOf(id: SynthesizableId): string | undefined
  /** Forgets everything in flight for `server`; returns the CLIENT ids now needing an error. */
  dropServer(server: string): readonly SynthesizableId[]
  readonly pending: number
}

/**
 * One tracked request. Discriminated on `origin` rather than carrying an
 * optional `tag`, so a fan-out entry cannot exist without the tag its reply
 * will be reported under — and `settle` needs no fallback for a case the type
 * already rules out.
 */
type PendingRequest =
  | { readonly origin: 'client'; readonly server: string; readonly id: SynthesizableId }
  | {
      readonly origin: 'fanout'
      readonly server: string
      readonly id: SynthesizableId
      readonly tag: string
    }

export function createPoolCorrelator(maxPending: number): PoolCorrelator {
  const pending = new Map<string, PendingRequest>()
  let fanoutCounter = 0

  /** Settles `key` only if the reply came from the server that owns it. */
  function take(server: string, key: string): PendingRequest | null {
    const entry = pending.get(key)
    // Deliberately no delete on a mismatch: one server must not be able to
    // burn another server's in-flight id by answering it.
    if (entry === undefined || entry.server !== server) return null
    pending.delete(key)
    return entry
  }

  return {
    trackClient(id: SynthesizableId, server: string): TrackOutcome {
      if (typeof id === 'string' && id.startsWith(POOL_FANOUT_ID_PREFIX)) {
        return { ok: false, reason: 'reserved-id' }
      }
      const key = idKeyOf(id)
      if (pending.has(key)) return { ok: false, reason: 'duplicate-id' }
      // Fail closed rather than evict: a forgotten id is a reply with nowhere
      // to go, so the caller answers the NEW request with an error instead.
      if (pending.size >= maxPending) return { ok: false, reason: 'at-capacity' }

      pending.set(key, { server, origin: 'client', id })
      return { ok: true }
    },

    trackFanout(server: string, tag: string): string | null {
      // Capped like a client request, and against the SAME budget. Fan-out is
      // plane-originated but agent-DRIVEN: every `tools/list` the agent sends
      // fans out to every member of its pool. Were fan-out exempt, entries for
      // servers that never answer would fill the map and `trackClient` would
      // then refuse every real request while not one slot held a client.
      if (pending.size >= maxPending) return null

      const id = `${POOL_FANOUT_ID_PREFIX}${(fanoutCounter += 1)}`
      pending.set(idKeyOf(id), { server, origin: 'fanout', id, tag })
      return id
    },

    settle(server: string, id: JsonRpcId): SettleOutcome {
      if (id === null) return { kind: 'unexpected' }

      const entry = take(server, idKeyOf(id))
      if (entry === null) return { kind: 'unexpected' }
      return entry.origin === 'client' ? { kind: 'client' } : { kind: 'fanout', tag: entry.tag }
    },

    serverOf(id: SynthesizableId): string | undefined {
      const entry = pending.get(idKeyOf(id))
      return entry?.origin === 'client' ? entry.server : undefined
    },

    dropServer(server: string): readonly SynthesizableId[] {
      const orphaned: SynthesizableId[] = []
      for (const [key, entry] of [...pending]) {
        if (entry.server !== server) continue
        pending.delete(key)
        // Only client ids are orphans: nobody outside the plane waits on a
        // fan-out id, so synthesizing an error for one would invent a reply.
        if (entry.origin === 'client') orphaned.push(entry.id)
      }
      return orphaned
    },

    get pending(): number {
      return pending.size
    },
  }
}
