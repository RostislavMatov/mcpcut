import type { EffectiveAgentLister } from '../agents/effective-reader.js'
import { PRODUCT_VERSION } from '../brand.js'
import {
  MAX_POOL_CHILD_SESSIONS,
  MAX_POOL_WARM_IDLE,
  POOL_CHILD_START_TIMEOUT_MS,
  POOL_WARM_IDLE_MS,
} from '../pool/constants.js'
import type { RegistryStore } from '../registry/store.js'
import type { HttpFront } from '../transport/http/server.js'
import type { OpenSession } from '../transport/http/session.js'
import { createChildSessionOpener, type ChildSessionDeps } from './serve-child.js'
import { poolResponseCorrelation, type ModelHandoff } from './serve-hooks.js'
import { createPoolSessionFactory } from './serve-pool.js'
import { createResidentSupervisor, type ResidentSupervisor } from './serve-residents.js'
import {
  POOL_RESIDENT_MAX_CONSECUTIVE_FAILURES,
  POOL_RESIDENT_RESTART_BASE_MS,
  POOL_RESIDENT_RESTART_MAX_MS,
  POOL_RESIDENT_START_CONCURRENCY,
} from './serve-residents-constants.js'
import { createResidentOpenStart, fingerprintOf, resolveDeclaredEnv } from './serve-residents-open.js'
import { startResidentReconcile, type ResidentReconcile } from './serve-residents-reconcile.js'

/**
 * Everything `serve` needs to offer the POOL address (ADR-0015 phase 3): the
 * session factory, and the two process-wide budgets its children draw on.
 *
 * Moved out of `serve-cmd.ts` unchanged, so that file keeps owning only the
 * run's lifecycle — flags, policy, stores, front, listen, shutdown — while the
 * accounting of pool children, which grows with every wave of the pool, lives
 * next to nothing else.
 */

export interface PoolWiringInput {
  /** What both serve modes hand a session, per-server and pooled alike. */
  readonly shared: ChildSessionDeps
  readonly registry: Pick<RegistryStore, 'getServer' | 'listServers'>
  /** Every agent with its effective grants: what the residents reconcile against. */
  readonly lister: EffectiveAgentLister
  /** How often residents reconcile; one number with the revocation poll (RS4). */
  readonly residentReconcileMs: number
  /** Pairs that may be resident (`MAX_POOL_RESIDENTS`, or a test's). */
  readonly maxPoolResidents: number
  readonly handoff: ModelHandoff
  /** The front's session ceiling, which every pool's children share (P5). */
  readonly maxSessions: number
  readonly revocationPollIntervalMs: number
  /** Test seam: see `ServeCommandOptions.poolFanoutTimeoutMs`. */
  readonly poolFanoutTimeoutMs?: number
  /** Test seam: see `ServeCommandOptions.poolWatchPollIntervalMs`. */
  readonly poolWatchPollIntervalMs?: number
  /** Test seam: see `ServeCommandOptions.poolStartTimeoutMs`. */
  readonly poolStartTimeoutMs?: number
  /** Test seam: see `ServeCommandOptions.poolWarmIdleMs`. */
  readonly poolWarmIdleMs?: number
  /** Test seam: see `ServeCommandOptions.poolResidentRestartBaseMs`. */
  readonly poolResidentRestartBaseMs?: number
  /**
   * The front, once it exists. A getter because the factory is built before
   * the front is: the front takes the factory as an argument.
   */
  readonly frontRef: () => HttpFront | null
}

export interface PoolWiring {
  readonly openPool: OpenSession
  /** Sessions the front's ceiling must count beyond its own (`extraSessions`). */
  readonly extraSessions: () => number
  /** The front's `reclaimSessions`: an idle warm server yields its slot (RS7). */
  readonly reclaim: () => boolean
  /** The held stdio servers of every agent (ADR-0016). */
  readonly supervisor: ResidentSupervisor
  /** Their lifecycle, for `serve`'s own (RS10). */
  readonly residents: ResidentsLifecycle
}

export interface ResidentsLifecycle {
  /** Starts reconciling: residents come up in the background. After `listen`. */
  start(): void
  /** Nothing is kept from here on: a pool session that closes closes its held sessions. */
  seal(): void
  /** Stops reconciling and closes every held session; waits for all of it. */
  close(): Promise<void>
}

export function createPoolWiring(input: PoolWiringInput): PoolWiring {
  const { shared } = input
  /**
   * Child sessions of every live pool. They cost an upstream each, so the
   * front's own ceiling has to see them (plan decision P5) — without this one
   * agent with broad grants would walk straight past `MAX_CONCURRENT_SESSIONS`.
   *
   * Counting them is only half of it: the front reserves a slot when a
   * top-level session OPENS, and a pool grows later, so the pool must also
   * CLAIM before opening each child. `reserveChildSlot` below is that claim,
   * and it is why the front is read through `frontRef` — the factory is built
   * before it.
   */
  let poolChildCount = 0
  /**
   * Child opens decided but not yet counted in `poolChildCount` — across EVERY
   * pool, which is the point. `activeSessionCount()` sees a child only once its
   * transport is up, so without a shared claim two pools growing at once each
   * saw room and both took it. This is `createSlotCounter`'s discipline applied
   * to the one budget that lives outside the session manager.
   */
  let poolChildrenOpening = 0

  /** Room for one more session or process in the front's shared budget, now. */
  function hasRoom(): boolean {
    const front = input.frontRef()
    return front !== null && front.activeSessionCount() + poolChildrenOpening < input.maxSessions
  }

  /**
   * Claims one slot of the front's shared budget, or refuses. Synchronous and
   * cheap by contract: it runs inside the children registry's loop, before any
   * await, exactly as the front's own `reserve()` does. An idle warm server
   * yields its slot first (RS7).
   *
   * No front yet means no. A pool can only be opened by a request the front
   * accepted, so that is unreachable — but a ceiling whose unknown state reads
   * as "room available" fails open, and this one bounds spawned processes.
   */
  function reserveGlobalSlot(): { release(): void } | null {
    if (!hasRoom() && !(supervisor.evictIdleWarm() && hasRoom())) {
      return null
    }
    poolChildrenOpening += 1
    let isReleased = false
    return {
      release: () => {
        if (isReleased) return
        isReleased = true
        poolChildrenOpening -= 1
      },
    }
  }

  /**
   * One child slot of ONE pool: the per-pool ceiling only. The shared budget
   * is claimed where the transport is known for certain — by the opener for
   * an ordinary child (`reserveProcessSlot`), by the supervisor for a process
   * it starts; an attachment to a held session costs nothing. Deciding it
   * here from a snapshot of the registry counted a stdio server registered
   * since the last reconcile TWICE.
   */
  function reserveChildSlot(held: number): { release(): void } | null {
    if (input.frontRef() === null || held >= MAX_POOL_CHILD_SESSIONS) {
      return null
    }
    return { release: () => undefined }
  }

  const supervisor = createResidentSupervisor({
    openStart: createResidentOpenStart({ childDeps: shared, planeVersion: PRODUCT_VERSION, now: Date.now }),
    readAgent: (name) => shared.agents.getAgent(name),
    resolveDeclared: (record) => resolveDeclaredEnv(shared, record),
    fingerprintOf,
    hasRoom,
    concurrency: POOL_RESIDENT_START_CONCURRENCY,
    startTimeoutMs: input.poolStartTimeoutMs ?? POOL_CHILD_START_TIMEOUT_MS,
    idleMs: input.poolWarmIdleMs ?? POOL_WARM_IDLE_MS,
    maxWarmIdle: MAX_POOL_WARM_IDLE,
    restartBaseMs: input.poolResidentRestartBaseMs ?? POOL_RESIDENT_RESTART_BASE_MS,
    restartMaxMs: POOL_RESIDENT_RESTART_MAX_MS,
    maxFailures: POOL_RESIDENT_MAX_CONSECUTIVE_FAILURES,
    now: Date.now,
    stderr: shared.stderr,
  })

  const openPool = createPoolSessionFactory({
    ...shared,
    registry: input.registry,
    handoff: input.handoff,
    // One opener per pool session, each reporting the exact vault values its
    // children were handed so that pool's own journal can redact by value.
    childSessionOpenerFor: (onSecrets) =>
      createChildSessionOpener({
        ...shared,
        upstream: {
          ...shared.upstream,
          // A member of the 2026-07-28 revision answers a method-level error
          // with a 4xx status; that must be a reply, not the end (RV4).
          httpClient: { deliverErrorBodies: true },
          resolveRefs: async (record) => {
            const result = await shared.upstream.resolveRefs(record)
            if (result.status === 'resolved') {
              onSecrets(Object.values(result.values))
            }
            return result
          },
        },
      }),
    correlate: poolResponseCorrelation,
    planeVersion: PRODUCT_VERSION,
    revocationPollIntervalMs: input.revocationPollIntervalMs,
    onChildCountChange: (delta) => {
      poolChildCount += delta
    },
    reserveChild: reserveChildSlot,
    residents: supervisor,
    reserveProcessSlot: reserveGlobalSlot,
    ...(input.poolFanoutTimeoutMs !== undefined
      ? { fanoutTimeoutMs: input.poolFanoutTimeoutMs }
      : {}),
    ...(input.poolWatchPollIntervalMs !== undefined
      ? { poolWatchPollIntervalMs: input.poolWatchPollIntervalMs }
      : {}),
    ...(input.poolStartTimeoutMs !== undefined ? { startTimeoutMs: input.poolStartTimeoutMs } : {}),
  })

  let reconcile: ResidentReconcile | null = null
  const residents: ResidentsLifecycle = {
    start: () => {
      reconcile ??= startResidentReconcile({
        agents: input.lister,
        registry: input.registry,
        supervisor,
        intervalMs: input.residentReconcileMs,
        cap: input.maxPoolResidents,
        stderr: shared.stderr,
      })
    },
    seal: () => supervisor.seal(),
    close: async () => {
      reconcile?.stop()
      await supervisor.closeAll()
    },
  }

  return {
    openPool,
    extraSessions: () => poolChildCount + supervisor.processCount,
    reclaim: () => supervisor.evictIdleWarm(),
    supervisor,
    residents,
  }
}
