import type { AgentRecord } from '../agents/schema.js'
import { buildPoolRecord, type PoolRecordInfo } from '../journal/pool-record.js'
import { createJournalSink, type JournalSinkOptions } from '../journal/sink.js'
import {
  MAX_POOL_LIST_PAGES,
  MAX_POOL_PENDING_REQUESTS,
  POOL_CHILD_START_TIMEOUT_MS,
  POOL_FANOUT_TIMEOUT_MS,
  POOL_START_TAGS,
  POOL_UPSTREAM_CLIENT_NAME,
} from '../pool/constants.js'
import { createPoolCatalog } from '../pool/catalog.js'
import {
  createPoolChildren,
  type PoolChildEvent,
  type PoolChildReservation,
} from '../pool/children.js'
import { createPoolCorrelator } from '../pool/correlator.js'
import { createPoolFanout } from '../pool/fanout.js'
import { negotiateUpstream } from '../pool/handshake.js'
import { createPoolMultiplexer } from '../pool/multiplexer.js'
import { createPoolWatch } from '../pool/watch.js'
import type { RegistryStore } from '../registry/store.js'
import type { AgentRecordReader } from '../session/agent-watch.js'
import { clientMessage, serverMessage } from '../transport/message.js'
import type {
  OpenSession,
  OpenedSession,
  OpenSessionRefusal,
  ResponseCorrelation,
  SessionContext,
} from '../transport/http/session.js'
import type { ServeWritable } from './serve-constants.js'
import type { ChildSessionOpener } from './serve-child.js'
import type { ModelHandoff } from './serve-hooks.js'
import { createMemoryPipe } from './serve-pipe.js'
import {
  POOL_MODEL_UNDETECTED_MESSAGE,
  POOL_STATELESS_MESSAGE,
  REFUSAL_POOL_NO_AGENT,
  REFUSAL_POOL_SESSIONFUL_ONLY,
  startRefusalLine,
} from './serve-pool-constants.js'
import { createPoolChildOpener } from './serve-pool-child.js'
import type { ResidentSupervisor } from './serve-residents.js'

/**
 * The `openSession` factory for the POOL address (ADR-0015 phase 3): one
 * authenticated agent becomes one multiplexer in front of N per-server child
 * sessions.
 *
 * This module is the seam the pool needs and is not allowed to reach for
 * itself: `src/pool/**` may not import `src/cli/**` (a mechanical test
 * enforces it), and the registry, the vault and the assembly of a child
 * session all live here. So `openChild` is built here and injected. The pool
 * decides WHAT is addressable; this file decides where a server comes from.
 *
 * Refusal order, and why:
 *
 *   1. downstream model known, and sessionful?  → fail closed / sessionful-only
 *   2. agent re-read from the store, not revoked? → `no-grant`
 *
 * There is no third step. A pool has no server to look up, and a pool with no
 * servers is a legal pool (an agent may hold no grants and still get an empty
 * catalog). A server that will not come up is refused per-server, later, as
 * an `attach-refused` record — PE6: the pool opens without it.
 */

export interface PoolSessionDeps {
  readonly registry: Pick<RegistryStore, 'getServer'>
  readonly agents: AgentRecordReader
  /** Downstream model of the request being opened (see `serve-hooks.ts`). */
  readonly handoff: ModelHandoff
  /**
   * Builds the child-session opener for ONE pool session, reporting every exact
   * vault value its children are handed to `onSecrets`.
   *
   * A factory rather than a ready opener so each pool gets its own collector:
   * the pool's own `kind:'pool'` journal must redact by exact value like every
   * other secret-adjacent producer in this codebase, and a refusal `reason` is
   * server- and vault-influenced text. Pattern matching alone would be the only
   * backstop otherwise.
   */
  readonly childSessionOpenerFor: (
    onSecrets: (values: readonly string[]) => void,
  ) => ChildSessionOpener
  /** How the front pairs a pool session's replies (`serve-hooks.ts`). */
  readonly correlate: ResponseCorrelation
  readonly journalDir: string
  readonly stderr: ServeWritable
  /** The plane's own version, for the `serverInfo` the pool reports (PE12). */
  readonly planeVersion: string
  /** Mints the pool session's OWN journal session id. */
  readonly newSessionId: () => string
  readonly clock?: () => number
  readonly revocationPollIntervalMs: number
  /** When true, a journal write failure ends the pool session it belongs to. */
  readonly failClosed: boolean
  /** Counts one child up (+1) or down (-1) against the process-wide ceiling. */
  readonly onChildCountChange: (delta: number) => void
  /**
   * Claims room for one more child, or `null` when there is none. Composed by
   * the caller from BOTH ceilings — the per-pool `MAX_POOL_CHILD_SESSIONS` and
   * the front's live session budget, which every pool shares (P5).
   */
  readonly reserveChild: (held: number) => PoolChildReservation | null
  /**
   * The resident supervisor (ADR-0016): stdio children are acquired from it
   * rather than spawned per pool session.
   */
  readonly residents: Pick<ResidentSupervisor, 'acquire'>
  /**
   * Claims one slot of the service's shared budget, synchronously, or `null`:
   * for every ordinary child — HTTP, or stdio when this agent's held session
   * is attached elsewhere (`busy`). The supervisor claims its own.
   */
  readonly reserveProcessSlot: () => PoolChildReservation | null
  /** @internal test-only seam mirroring `wrap`'s, for fail-closed tests. */
  readonly journalCommitBatchImpl?: JournalSinkOptions['commitBatchImpl']
  /** Fan-out budget override for tests; defaults to `POOL_FANOUT_TIMEOUT_MS`. */
  readonly fanoutTimeoutMs?: number
  /** Start budget override for tests; defaults to `POOL_CHILD_START_TIMEOUT_MS`. */
  readonly startTimeoutMs?: number
  /**
   * How often the POOL's own watch re-reads the agent, apart from the one every
   * child session runs. Tests shorten or lengthen it to decide which of the two
   * watches notices a withdrawn grant first; nothing else should — both follow
   * `revocationPollIntervalMs` in the product.
   */
  readonly poolWatchPollIntervalMs?: number
}

export function createPoolSessionFactory(deps: PoolSessionDeps): OpenSession {
  function report(ctx: SessionContext, message: string): void {
    deps.stderr.write(`[serve] ${ctx.agentName}/pool: ${message}\n`)
  }

  /**
   * Steps 1-2 of the refusal order. `handoff.take()` is the FIRST statement
   * for the reason `serve-hooks.ts` documents: the note is one-shot and is
   * read back in the same synchronous chain that wrote it.
   */
  async function resolveAgent(
    ctx: SessionContext,
  ): Promise<AgentRecord | OpenSessionRefusal> {
    const model = deps.handoff.take()
    if (model === null) {
      report(ctx, POOL_MODEL_UNDETECTED_MESSAGE)
      return { error: REFUSAL_POOL_SESSIONFUL_ONLY }
    }
    if (model === 'stateless') {
      report(ctx, POOL_STATELESS_MESSAGE)
      return { error: REFUSAL_POOL_SESSIONFUL_ONLY }
    }
    // Re-read rather than trusting the front's authentication result, so a
    // revocation between the token check and the opening cannot produce a
    // live pool.
    const agent = await deps.agents.getAgent(ctx.agentName)
    if (agent === undefined || agent.revokedAt !== undefined) {
      return { error: REFUSAL_POOL_NO_AGENT }
    }
    return agent
  }

  const openSession: OpenSession = async (ctx) => {
    const resolved = await resolveAgent(ctx)
    if ('error' in resolved) {
      return resolved
    }
    return openPool(ctx, resolved)
  }

  async function openPool(
    ctx: SessionContext,
    /** The record the pool opened with; the watch's starting membership only. */
    agent: AgentRecord,
  ): Promise<OpenedSession | OpenSessionRefusal> {
    const poolSessionId = deps.newSessionId()
    const pipe = createMemoryPipe()
    let endPool: () => void = () => undefined
    /**
     * Exact values this pool's children were given upstream. Collected so the
     * pool's own records are redacted the way a child session's are, rather
     * than relying on pattern matching plus the discipline of every module that
     * might ever populate a `reason`.
     */
    const knownSecrets = new Set<string>()
    const collectSecrets = (values: readonly string[]): void => {
      for (const value of values) {
        knownSecrets.add(value)
      }
    }
    const openChildSession = deps.childSessionOpenerFor(collectSecrets)

    const sink = createJournalSink(poolSessionId, {
      dir: deps.journalDir,
      ...(deps.journalCommitBatchImpl !== undefined
        ? { commitBatchImpl: deps.journalCommitBatchImpl }
        : {}),
      ...(deps.failClosed
        ? {
            onWriteError: () => {
              // "No audit record, no traffic", at pool granularity: this
              // agent's pool dies, every other session lives on.
              deps.stderr.write(
                `[serve] journal write failed in pool session ${poolSessionId}; ending it\n`,
              )
              endPool()
            },
          }
        : {}),
    })

    /** One `kind:'pool'` record. Never throws into the traffic path. */
    const journal = (info: PoolRecordInfo): void => {
      try {
        sink.write(
          buildPoolRecord({
            sessionId: poolSessionId,
            pool: info,
            knownSecrets: [...knownSecrets],
            ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
          }),
        )
      } catch (error: unknown) {
        report(ctx, describeError(error))
      }
    }

    const openChild = createPoolChildOpener({
      ctx,
      registry: deps.registry,
      agents: deps.agents,
      openChildSession,
      report: (message) => report(ctx, message),
      onChildCountChange: deps.onChildCountChange,
      residents: deps.residents,
      reserveProcessSlot: deps.reserveProcessSlot,
      onSecrets: collectSecrets,
    })

    const correlator = createPoolCorrelator(MAX_POOL_PENDING_REQUESTS)
    const fanout = createPoolFanout({
      correlator,
      timeoutMs: deps.fanoutTimeoutMs ?? POOL_FANOUT_TIMEOUT_MS,
      onTimeout: (server: string, tag: string) => {
        // A start that ran out of budget was never a member: `attach-refused`
        // says so, and `detach` would be a no-op under a false stderr line.
        if (POOL_START_TAGS.has(tag)) return
        // P4: a silent upstream is detached rather than left holding
        // correlation entries until the table fills.
        report(ctx, `server ${server} did not answer in time; detaching it`)
        // Dirty by definition: the request it did not answer is still out.
        void children.detach(server, 'fanout-timeout', { dirty: true })
      },
    })
    const startTimeoutMs = deps.startTimeoutMs ?? POOL_CHILD_START_TIMEOUT_MS
    const now = deps.clock ?? Date.now
    const children = createPoolChildren({
      openChild,
      // The plane introduces itself to every upstream in its own name, with
      // no client capabilities declared (PE3, ADR-0015 §4) — the agent's own
      // handshake never reaches one, because the plane answered it (PE12).
      negotiate: (child, start) =>
        negotiateUpstream({
          ask: (tag, buildLine, timeoutMs) => fanout.ask(child, tag, buildLine, { timeoutMs }),
          // Unstamped: `notifications/initialized` only ever closes a
          // SESSIONFUL handshake.
          notify: (line) => child.sink.write(clientMessage(Buffer.from(line, 'utf8'))),
          hint: start.hint,
          deadline: start.deadline,
          now,
          planeVersion: deps.planeVersion,
        }),
      clientInfo: { name: POOL_UPSTREAM_CLIENT_NAME, version: deps.planeVersion },
      startTimeoutMs,
      now,
      abandonStart: (server) => {
        // Both halves: the waits end now, and the entries they held do not
        // linger against `MAX_POOL_PENDING_REQUESTS` (BU2).
        fanout.abandon(server)
        correlator.dropServer(server)
      },
      reserveChild: deps.reserveChild,
      onEvent: (event) => {
        journal(childEventInfo(ctx.agentName, event))
        if (event.event === 'attach-refused') {
          const line = startRefusalLine(event.server, event.reason, startTimeoutMs)
          if (line !== null) report(ctx, line)
        }
        if (event.event === 'detach') {
          // EVERY departure, not only an ungranted one: a child whose own
          // session ended, and one detached for not answering, leave calls in
          // flight behind exactly the same way. Both reviews of phase 3 found
          // the bug that came of wiring only the membership path.
          mux.releaseServer(event.server)
        }
      },
      onChildMessage: (server, message) => mux.handleChildFrame(server, message),
    })
    const catalog = createPoolCatalog({ fanout, children, maxPages: MAX_POOL_LIST_PAGES })
    const watch = createPoolWatch({
      agentName: ctx.agentName,
      initial: agent,
      readAgent: () => deps.agents.getAgent(ctx.agentName),
      pollIntervalMs: deps.poolWatchPollIntervalMs ?? deps.revocationPollIntervalMs,
      onRevoked: () => {
        report(ctx, `pool session ${poolSessionId} ended (revoked)`)
        endPool()
      },
      onChanged: (grantedNow) => {
        void mux.onMembershipChanged(grantedNow).catch((error: unknown) => {
          report(ctx, describeError(error))
        })
      },
      onError: (error) => report(ctx, describeError(error)),
    })

    const mux = createPoolMultiplexer({
      agentName: ctx.agentName,
      planeVersion: deps.planeVersion,
      children,
      catalog,
      correlator,
      fanout,
      watch,
      journal,
      toAgent: (bytes) => {
        void pipe.session.sink.write(serverMessage(bytes))
      },
      onError: (error) => report(ctx, describeError(error)),
    })

    pipe.session.source.onMessage((message) => mux.handleAgentFrame(message.bytes))
    journal({ agentName: ctx.agentName, event: 'open', members: watch.granted })
    watch.start()

    let closePromise: Promise<void> | null = null
    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        journal({ agentName: ctx.agentName, event: 'close' })
        await mux.close()
        await sink.close()
      })()
      return closePromise
    }
    // Ends the pool from the inside (revocation, a lost journal write): the
    // front's teardown then calls `close()`, which is what reaps the children.
    endPool = () => {
      pipe.endFrontSource()
    }

    return {
      sink: pipe.front.sink,
      source: pipe.front.source,
      // Several of this agent's calls may be in flight at once — that is the
      // whole point of a pool (plan decision P1).
      correlate: deps.correlate,
      close,
    }
  }

  return openSession
}

/**
 * One `PoolChildEvent` as journal record info.
 *
 * Written out field by field rather than spread. A spread read well and was
 * wrong: the pool layer calls the field `server` and a record carries
 * `serverName`, so every attach and every refusal was journaled WITHOUT the
 * server it was about — a line saying a child came up, but not to what, and a
 * PE6 refusal with no way to tell which server refused. Being explicit also
 * means adding a field to the event forces a decision here instead of
 * silently going nowhere.
 */
function childEventInfo(agentName: string, event: PoolChildEvent): PoolRecordInfo {
  return {
    agentName,
    event: event.event,
    serverName: event.server,
    ...(event.event === 'attach' ? { childSessionId: event.childSessionId } : {}),
    ...(event.event === 'attach' ? { lifetime: event.lifetime } : {}),
    ...(event.event === 'attach' ? {} : { reason: event.reason }),
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
