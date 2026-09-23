import type { AgentsStore } from '../agents/store.js'
import type { GroupsStore } from '../groups/store.js'
import type { JournalSinkOptions } from '../journal/sink.js'
import type { LoadPolicyOptions } from '../policy/load.js'
import type { RegistryStore } from '../registry/store.js'
import type { ServeServiceDefaults } from '../setup/bind.js'
import type { VaultStore } from '../vault/store.js'

/**
 * What `runServe` can be handed (`serve-cmd.ts`): the stores, the policy
 * options, and the test seams. Its own file for the size budget — the list of
 * seams grows with every wave of the pool, and the command keeps the run's
 * lifecycle.
 */

/** Live front, handed to the caller once the socket is bound. */
export interface ServeHandle {
  readonly port: number
  readonly host: string
  /** Graceful shutdown; idempotent. Resolves once the front is fully closed. */
  shutdown(): Promise<void>
}

/** Stores `serve` reads; injectable so tests never touch the real journal dir. */
export interface ServeStores {
  readonly registry?: RegistryStore
  readonly agents?: Pick<AgentsStore, 'getAgent' | 'findAgentByToken' | 'listAgents'>
  /** Group source for effective grants (M5.5 п.2); defaults to `<journalDir>/state.db`. */
  readonly groups?: Pick<GroupsStore, 'groupsOf'>
  readonly vault?: Pick<VaultStore, 'readSecretValues'>
}

export interface ServeCommandOptions {
  /** Journal directory for stores, journal files, approvals and inventory. */
  readonly journalDir?: string
  readonly stores?: ServeStores
  /** Forwarded to `loadPolicy` unchanged (minus `explicitPath`, which is `--policy`). */
  readonly loadPolicy?: Omit<LoadPolicyOptions, 'explicitPath'>
  /** The plane's environment; only its allowlisted slice reaches a child. */
  readonly processEnv?: NodeJS.ProcessEnv
  /** Journal session id factory. Defaults to `ulid()`. */
  readonly newSessionId?: () => string
  readonly clock?: () => number
  /** Agent revocation poll interval per session; defaults to the ≤5 s constant. */
  readonly revocationPollIntervalMs?: number
  /**
   * How long ONE upstream may take to answer a pool catalog fan-out before it
   * is detached. Tests shorten it; nothing else should — `POOL_FANOUT_TIMEOUT_MS`
   * is the value the product ships with.
   */
  readonly poolFanoutTimeoutMs?: number
  /**
   * How often a pool session's OWN watch re-reads its agent. Every child
   * session runs a watch of its own on `revocationPollIntervalMs`; tests set
   * the two apart to decide which notices a withdrawn grant first. Tests
   * shorten it; nothing else should — in the product both are one number.
   */
  readonly poolWatchPollIntervalMs?: number
  /**
   * How long ONE pooled server may take to come up — open, spawn and
   * handshake under one deadline (BU1). Tests shorten it; nothing else should
   * — `POOL_CHILD_START_TIMEOUT_MS` is the value the product ships with.
   */
  readonly poolStartTimeoutMs?: number
  /**
   * (agent, stdio server) pairs kept running between connections (ADR-0016).
   * The test harnesses set 0 so older tests see no background processes;
   * nothing else should — `MAX_POOL_RESIDENTS` is the value the product ships.
   */
  readonly maxPoolResidents?: number
  /**
   * How often residents reconcile against grants and the registry. Defaults
   * to `revocationPollIntervalMs`: "withdrawn → stopped within 5 s" is one
   * number. Tests shorten it; nothing else should.
   */
  readonly poolResidentReconcileMs?: number
  /** First pause before a crashed resident restarts. Tests shorten it; nothing else should. */
  readonly poolResidentRestartBaseMs?: number
  /**
   * How long an idle warm server lives; `0` closes it at release. Tests set it;
   * nothing else should — `POOL_WARM_IDLE_MS` is the value the product ships.
   */
  readonly poolWarmIdleMs?: number
  /**
   * Concurrently open sessions this front allows, counting a pool's children
   * (plan decision P5). A test seam like the two above: driving the real
   * ceiling would need 64 upstreams, and the point under test is that the
   * children are COUNTED, not what the number is.
   */
  readonly maxSessions?: number
  readonly approvalsBaseDir?: string
  readonly inventoryStorePath?: string
  /** Signals that trigger a graceful shutdown. `[]` installs none (tests). */
  readonly signals?: readonly NodeJS.Signals[]
  /** Called once the socket is bound, with the handle that can shut it down. */
  readonly onListening?: (handle: ServeHandle) => void
  /**
   * What every absent flag falls back to (phase 1, task 5). Defaults to the
   * environment-plus-install-config resolution; injected by tests and by any
   * caller that already read the config.
   */
  readonly bindDefaults?: ServeServiceDefaults
  readonly killEscalationMs?: number
  /**
   * @internal test-only seam for injecting a failing journal batch commit
   * (the same seam `RunWrapOptions` exposes), so fail-closed behaviour can be
   * exercised without an unwritable disk.
   */
  readonly journalCommitBatchImpl?: JournalSinkOptions['commitBatchImpl']
}
