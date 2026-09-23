import type { McpMessage, MessageSink, MessageSource } from '../transport/message.js'
import {
  emptyRouteTable,
  routeOf,
  serversOf,
  withoutRoute,
  withRoute,
  type RouteTable,
} from './route-table.js'

/**
 * The live child sessions of one pool, over the phase-1 route table
 * (ADR-0015 §5).
 *
 * What this module deliberately cannot do is as load-bearing as what it does:
 * it never reads a registry, a vault or a config, because `src/pool/**` may
 * not import `src/cli/**` (a mechanical test enforces it). Opening one child
 * is an injected effect. That is not a way around the rule — it is the reason
 * the rule exists: the pool decides WHAT is addressable, and not where a
 * server comes from.
 *
 * Every failure here is a smaller pool, never a broken one (PE6). A server
 * that refused, threw, or did not fit under the ceiling is simply absent, and
 * the fact is reported through `onEvent` so it reaches the journal.
 */

/** A live child session of a pool, as the multiplexer sees it. */
export interface PoolChild {
  readonly server: string
  /** Journal session id of that child — the binding a `kind:'pool'` record carries. */
  readonly sessionId: string
  readonly sink: MessageSink
  close(): Promise<void>
}

export type OpenPoolChildResult =
  | { readonly status: 'opened'; readonly child: PoolChild; readonly source: MessageSource }
  | { readonly status: 'refused'; readonly reason: string }

/** Opening one child is the caller's job: `src/pool` may not read a registry. */
export type OpenPoolChild = (server: string) => Promise<OpenPoolChildResult>

/** A claim on one child slot, released once the child is counted or refused. */
export interface PoolChildReservation {
  /** Gives the claim back. Idempotent. */
  release(): void
}

/** What happened to one membership of the pool; goes straight to the journal. */
export type PoolChildEvent =
  | { readonly event: 'attach'; readonly server: string; readonly childSessionId: string }
  | { readonly event: 'attach-refused'; readonly server: string; readonly reason: string }
  | { readonly event: 'detach'; readonly server: string; readonly reason: string }

export interface PoolChildrenDeps {
  readonly openChild: OpenPoolChild
  /**
   * Introduces the plane to a freshly opened child (`handshake.ts`). It runs
   * BEFORE the child becomes routable, so a `tools/call` can never reach an
   * upstream that has not been initialized; `false` means the server did not
   * come up, and the pool opens without it (PE6).
   */
  readonly handshake: (child: PoolChild) => Promise<boolean>
  /**
   * Claims room for one more child, or `null` when there is none. `held` is what
   * this pool already has plus what it is opening.
   *
   * A RESERVATION rather than a question, and for the same reason the front's
   * own `reserve()` is one: two ceilings apply, and the process-wide one is
   * shared with every other pool. A predicate could only report what had
   * already finished opening, so two pools growing at once each saw room and
   * both took it. The claim is taken synchronously, before the open starts, and
   * given back once that child is either counted by the caller or refused.
   *
   * The per-pool ceiling (`MAX_POOL_CHILD_SESSIONS`) and the process-wide one
   * both live in the caller, which is the only place that can see both.
   */
  readonly reserveChild: (held: number) => PoolChildReservation | null
  /** Reports every attach, refusal and detach. Must not throw. */
  readonly onEvent: (event: PoolChildEvent) => void
  /** Every frame a child emitted, tagged with the server it came from. */
  readonly onChildMessage: (server: string, message: McpMessage) => void
}

export interface PoolChildren {
  /** Servers currently routed, sorted. */
  servers(): readonly string[]
  childOf(server: string): PoolChild | undefined
  /** Opens every granted server not yet up (PE7, lazy). Never throws, never rejects. */
  ensure(granted: readonly string[]): Promise<void>
  /** Closes one child and forgets it, reporting the reason. Absent server: no-op. */
  detach(server: string, reason: string): Promise<void>
  /** Closes everything. Idempotent; nothing opens afterwards. */
  closeAll(): Promise<void>
}

/** The refusal reason for a pool that has reached its own ceiling. */
const POOL_FULL_REASON = 'pool-full'

/** The detach reason for a child whose own session ended under us. */
const CHILD_ENDED_REASON = 'child-ended'

/** The refusal reason for an upstream that would not complete the handshake. */
const HANDSHAKE_FAILED_REASON = 'handshake-failed'

export function createPoolChildren(deps: PoolChildrenDeps): PoolChildren {
  /** Replaced whole on every change (IMMUTABLE_STATE_SWAP), never mutated. */
  let table: RouteTable<PoolChild> = emptyRouteTable<PoolChild>()
  /**
   * Opens in flight, so two overlapping `ensure` calls — ordinary on a
   * correlating session with two `tools/list` at once — join the same open
   * instead of racing two upstreams into one slot.
   */
  const opening = new Map<string, Promise<void>>()
  let isClosed = false

  function detachRoute(server: string, reason: string): PoolChild | undefined {
    const child = routeOf(table, server)
    if (child === undefined) {
      return undefined
    }
    table = withoutRoute(table, server)
    deps.onEvent({ event: 'detach', server, reason })
    return child
  }

  async function openOne(server: string, reservation: PoolChildReservation): Promise<void> {
    /** Set once this instance is in the table; see `isCurrentInstance`. */
    let isRouted = false
    let result: OpenPoolChildResult
    try {
      result = await deps.openChild(server)
    } catch (error: unknown) {
      // A server that blew up is a server that is not there. Letting this
      // escape would take the agent's whole `tools/list` down with it.
      result = { status: 'refused', reason: describeRefusal(error) }
    } finally {
      // Handed back the instant `openChild` returns: by then the caller has
      // either counted this child against the process budget itself, or there
      // is no child to count. Holding it longer would double-count.
      reservation.release()
    }
    if (result.status === 'refused') {
      deps.onEvent({ event: 'attach-refused', server, reason: result.reason })
      return
    }
    /**
     * Whether THIS instance still speaks for `server`.
     *
     * Only two states qualify: it is mid-handshake (not yet routable, but the
     * handshake's own reply must reach the caller — it arrives by this very
     * path), or it is the instance the table currently holds. A predecessor's
     * late frame must never be read as its successor's: the correlator keys an
     * in-flight id by server NAME, so a dead child's reply credited to the
     * reopened one is how a fabricated result could reach the agent. This is
     * the second lock on that door — `releaseServer` on every detach is the
     * first — and it is here because only this module can tell the two
     * instances apart.
     */
    const isCurrentInstance = (): boolean =>
      !isRouted || routeOf(table, server) === result.child

    // Registered BEFORE anything else awaits: a handler attached after an
    // await silently loses whatever the source emitted meanwhile — the lesson
    // `bridge/pump.ts` records.
    result.source.onMessage((message) => {
      if (isCurrentInstance()) {
        deps.onChildMessage(server, message)
      }
    })
    result.source.onEnd(() => {
      void detachRoute(server, CHILD_ENDED_REASON)?.close()
    })

    const isReady = await deps.handshake(result.child)
    if (!isReady || isClosed) {
      await result.child.close()
      if (!isClosed) {
        deps.onEvent({ event: 'attach-refused', server, reason: HANDSHAKE_FAILED_REASON })
      }
      return
    }

    table = withRoute(table, server, result.child)
    isRouted = true
    deps.onEvent({ event: 'attach', server, childSessionId: result.child.sessionId })
  }

  function startOpen(server: string, reservation: PoolChildReservation): Promise<void> {
    const existing = opening.get(server)
    if (existing !== undefined) {
      reservation.release()
      return existing
    }
    const started = openOne(server, reservation).finally(() => opening.delete(server))
    opening.set(server, started)
    return started
  }

  return Object.freeze({
    servers: () => serversOf(table),
    childOf: (server: string) => routeOf(table, server),

    async ensure(granted: readonly string[]): Promise<void> {
      if (isClosed) {
        return
      }
      const pending: Promise<void>[] = []
      for (const server of granted) {
        if (routeOf(table, server) !== undefined) {
          continue
        }
        const already = opening.get(server)
        if (already !== undefined) {
          pending.push(already)
          continue
        }
        // Claimed against what is already up AND what is on its way, so N
        // parallel opens cannot all pass a ceiling only one of them fits.
        const reservation = deps.reserveChild(serversOf(table).length + opening.size)
        if (reservation === null) {
          deps.onEvent({ event: 'attach-refused', server, reason: POOL_FULL_REASON })
          continue
        }
        pending.push(startOpen(server, reservation))
      }
      // `allSettled`, though `openOne` never rejects: the guarantee that one
      // server cannot abort the others belongs here too, not only upstream.
      await Promise.allSettled(pending)
    },

    async detach(server: string, reason: string): Promise<void> {
      await detachRoute(server, reason)?.close()
    },

    /**
     * Deliberately does NOT report a `detach` per child, and so does not
     * release the calls in flight at them. That is not the oversight it looks
     * like: `closeAll` runs only when the whole pool session is going, and the
     * front has already rejected every waiting request with the 404 a
     * terminated session owes them (matrix §1.5). Synthesizing `-32005` into a
     * pipe being torn down would reach nobody. Every OTHER departure does
     * report, which is what `releaseServer` hangs off.
     */
    async closeAll(): Promise<void> {
      isClosed = true
      const live = serversOf(table).map((server) => routeOf(table, server))
      table = emptyRouteTable<PoolChild>()
      await Promise.allSettled(live.map((child) => child?.close()))
    },
  })
}

/** Class and message only — never a stack, never a body. */
function describeRefusal(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
