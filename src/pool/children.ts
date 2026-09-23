import type { StatelessClientMeta } from '../protocol/mcp-stateless.js'
import type { McpMessage, MessageSink, MessageSource } from '../transport/message.js'
import type { NegotiationOutcome, PoolMemberDiscipline, UpstreamRevisionHint } from './handshake.js'
import { statelessMember } from './member.js'
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
  /**
   * Lets the child go. `dirty` = requests of this pool were still in flight
   * there: a child the caller would otherwise keep (a held session, ADR-0016)
   * must then not be attached again, or a late reply could reach a pool that
   * did not ask for it (RS5). A child that is simply closed ignores it.
   */
  close(options?: { readonly dirty?: boolean }): Promise<void>
}

export type OpenPoolChildResult =
  | {
      readonly status: 'opened'
      readonly child: PoolChild
      readonly source: MessageSource
      /**
       * The pool's word for why this child's own session ended, asked the
       * moment it ends; `undefined` means `child-ended` (DR1). Lets a child
       * that its OWN watch ended over a withdrawn grant leave as `ungranted`
       * — the same record the pool's watch writes when it gets there first,
       * so which watch wins the race no longer shows in the journal.
       */
      readonly departureReason?: () => string | undefined
      /** Which negotiation to run; `legacy-first` when absent (RV1). */
      readonly revisionHint?: UpstreamRevisionHint
      /**
       * The discipline of a child whose negotiation already happened (a held
       * session the pool attaches to): `negotiate` is skipped entirely.
       */
      readonly negotiated?: PoolMemberDiscipline
      /**
       * How long the child lives (ADR-0016): `pool` — with this pool session,
       * the default; `warm`/`resident` — a held session this pool attached to.
       */
      readonly lifetime?: PoolChildLifetime
    }
  | { readonly status: 'refused'; readonly reason: string }

/** How long one child lives; see `OpenPoolChildResult`. */
export type PoolChildLifetime = 'pool' | 'warm' | 'resident'

/**
 * Opening one child is the caller's job: `src/pool` may not read a registry.
 * `start.deadline` is the start's ONE deadline (BU1): a caller that waits for
 * a server someone else is starting waits no longer than this.
 */
export type OpenPoolChild = (server: string, start: { readonly deadline: number }) => Promise<OpenPoolChildResult>

/** A claim on one child slot, released once the child is counted or refused. */
export interface PoolChildReservation {
  /** Gives the claim back. Idempotent. */
  release(): void
}

/** What happened to one membership of the pool; goes straight to the journal. */
export type PoolChildEvent =
  | {
      readonly event: 'attach'
      readonly server: string
      readonly childSessionId: string
      readonly lifetime: PoolChildLifetime
    }
  | { readonly event: 'attach-refused'; readonly server: string; readonly reason: string }
  | { readonly event: 'detach'; readonly server: string; readonly reason: string }

/** What `negotiate` is told about one start. */
export interface NegotiationContext {
  /** Which negotiation the registry record asks for (RV1). */
  readonly hint: UpstreamRevisionHint
  /** The start's ONE deadline (BU1), shared with the open that came before. */
  readonly deadline: number
}

export interface PoolChildrenDeps {
  readonly openChild: OpenPoolChild
  /**
   * Introduces the plane to a freshly opened child (`handshake.ts`). It runs
   * BEFORE the child becomes routable, so a `tools/call` can never reach an
   * upstream that has not been initialized; a failure means the server did
   * not come up, and the pool opens without it (PE6).
   */
  readonly negotiate: (child: PoolChild, ctx: NegotiationContext) => Promise<NegotiationOutcome>
  /** Who the plane says it is to a stateless member, stamped on every frame (RV3). */
  readonly clientInfo: StatelessClientMeta
  /** How long one start may take in all, open and handshake together (BU1). */
  readonly startTimeoutMs: number
  readonly now?: () => number
  /**
   * The child died before it was routed: ends the start's waits at once
   * rather than at the deadline (BU2). The caller owns the fan-out and the
   * correlator, so it is the caller that lets go of them.
   */
  readonly abandonStart: (server: string) => void
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
  /**
   * Closes one child and forgets it, reporting the reason. Absent server:
   * no-op. `dirty` = the pool still had requests in flight there (RS5).
   */
  detach(server: string, reason: string, options?: { readonly dirty?: boolean }): Promise<void>
  /** Closes everything, each child dirty or not by `dirtyOf`. Idempotent; nothing opens afterwards. */
  closeAll(options?: { readonly dirtyOf?: (server: string) => boolean }): Promise<void>
}

/** The refusal reason for a pool that has reached its own ceiling. */
const POOL_FULL_REASON = 'pool-full'

/** The detach reason for a child whose own session ended under us. */
const CHILD_ENDED_REASON = 'child-ended'

/** The refusal reason for a child whose process or connection died mid-start (BU2). */
const ENDED_DURING_START_REASON = 'ended-during-start'

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

  const now = deps.now ?? Date.now

  async function openOne(server: string, reservation: PoolChildReservation): Promise<void> {
    /** Set once this instance is in the table; see `isCurrentInstance`. */
    let isRouted = false
    /** True while the plane's introduction is still waiting (BU2). */
    let isStarting = true
    /** Set when the child's source ended during its start (BU2). */
    let hasEnded = false
    // Taken BEFORE the open: the owner's budget is "start plus handshake", and
    // the spawn is part of the start (BU1).
    const deadline = now() + deps.startTimeoutMs
    let result: OpenPoolChildResult
    try {
      result = await deps.openChild(server, { deadline })
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
    let member: PoolChild = result.child
    const isCurrentInstance = (): boolean => !isRouted || routeOf(table, server) === member

    // Registered BEFORE anything else awaits: a handler attached after an
    // await silently loses whatever the source emitted meanwhile — the lesson
    // `bridge/pump.ts` records.
    result.source.onMessage((message) => {
      if (isCurrentInstance()) {
        deps.onChildMessage(server, message)
      }
    })
    result.source.onEnd(() => {
      if (!isRouted) {
        // Dead before it was a member: nothing to detach, but the start is
        // waiting on an answer that will never come (BU2). An end AFTER the
        // start gave up is the close below, and changes nothing.
        if (isStarting) {
          hasEnded = true
          deps.abandonStart(server)
        }
        return
      }
      void detachRoute(server, result.departureReason?.() ?? CHILD_ENDED_REASON)?.close()
    })

    const outcome: NegotiationOutcome =
      result.negotiated !== undefined
        ? { ok: true, discipline: result.negotiated }
        : await deps.negotiate(result.child, {
            hint: result.revisionHint ?? 'legacy-first',
            deadline,
          })
    isStarting = false
    // Judged BEFORE the close: closing ends the source too, and that end is
    // not the reason the start failed.
    const failure = hasEnded ? ENDED_DURING_START_REASON : outcome.ok ? null : outcome.reason
    if (!outcome.ok || failure !== null || isClosed) {
      await result.child.close()
      if (!isClosed && failure !== null) {
        deps.onEvent({ event: 'attach-refused', server, reason: failure })
      }
      return
    }

    // Wrapped only now: the handshake itself must not be stamped (RV3).
    member =
      outcome.discipline.model === 'stateless' ? statelessMember(result.child, deps.clientInfo) : result.child
    table = withRoute(table, server, member)
    isRouted = true
    deps.onEvent({ event: 'attach', server, childSessionId: member.sessionId, lifetime: result.lifetime ?? 'pool' })
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

    async detach(server: string, reason: string, options?: { readonly dirty?: boolean }): Promise<void> {
      await detachRoute(server, reason)?.close(options?.dirty === true ? { dirty: true } : undefined)
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
    async closeAll(options?: { readonly dirtyOf?: (server: string) => boolean }): Promise<void> {
      isClosed = true
      const live = serversOf(table).map((server) => ({ server, child: routeOf(table, server) }))
      table = emptyRouteTable<PoolChild>()
      await Promise.allSettled(
        live.map(({ server, child }) =>
          child?.close(options?.dirtyOf?.(server) === true ? { dirty: true } : undefined),
        ),
      )
    },
  })
}

/** Class and message only — never a stack, never a body. */
function describeRefusal(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
