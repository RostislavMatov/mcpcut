import type { AgentRecord } from '../agents/schema.js'
import { agentScope, type AgentScope } from '../agents/scope.js'
import { grantsHashOf, type GrantMatrix } from '../policy/provenance.js'
import type { GateAgentScope } from '../proxy/gate-helpers.js'

/**
 * Live agent-authorization watch for one session (M3).
 *
 * `agent revoke` must end live sessions within the polling interval (plan
 * gate: revocation is one action), and grant edits must take effect on the
 * next call without restarting the session. This module owns exactly that:
 * it re-reads the agent's record on an interval and
 *
 *  - ends the watch via `onRevoked()` when the agent is gone, revoked, or
 *    its grant for this server was removed entirely;
 *  - otherwise swaps the current `AgentScope` for one derived from the
 *    fresh record, so the gate's next `isGranted` sees the new matrix.
 *
 * The `scope` this watch exposes is a *stable* `GateAgentScope` facade over
 * the mutable current scope — the gate captures it once at construction and
 * every later call delegates to whatever the last successful poll derived.
 *
 * A poll that fails to read the store (transient fs error, a SQLite busy
 * timeout racing a concurrent CLI update) is reported and retried on the
 * next tick, keeping the last known-good scope: authorization never widens
 * on an error, and a transient hiccup must not kill a healthy session. The
 * revocation window is therefore bounded by the interval only while the
 * store is readable — an unreadable store extends it, which the report
 * makes visible.
 *
 * The timer is `unref()`d so a watch can never keep the process alive.
 */

/** The single store read the watch needs; `agents/store.ts` satisfies it. */
export interface AgentRecordReader {
  getAgent(name: string): Promise<AgentRecord | undefined>
}

export interface AgentWatchDeps {
  /** The authenticated agent's record as of session start. */
  readonly record: AgentRecord
  /** Registry name of the server this session proxies. */
  readonly serverName: string
  readonly store: AgentRecordReader
  readonly pollIntervalMs: number
  /** Fired at most once: the agent lost this server. The watch stops itself first. */
  readonly onRevoked: () => void
  readonly onError: (error: unknown) => void
}

export interface AgentWatch {
  /** Stable scope for the gate; delegates to the freshest polled record. */
  readonly scope: GateAgentScope
  /** Starts the polling timer. Idempotent. */
  start(): void
  /** Stops polling; a poll already in flight can no longer revoke or swap. Idempotent. */
  stop(): void
}

/** True when `record` no longer authorizes any traffic to `serverName`. */
export function isRevokedFor(record: AgentRecord | undefined, serverName: string): boolean {
  return (
    record === undefined ||
    record.revokedAt !== undefined ||
    !Object.hasOwn(record.grants, serverName)
  )
}

/**
 * What one poll resolved: the scope the gate decides against and the exact
 * matrix it was derived from.
 *
 * One immutable object rather than two variables, so a poll swaps both in a
 * SINGLE assignment. Two assignments left a window — however narrow — in
 * which the new scope decided calls while the old fingerprint was stamped on
 * their records, which is the precise opposite of the lockstep this module
 * promises (review L3).
 */
interface WatchState {
  readonly scope: AgentScope
  /** The WHOLE `record.grants`, not just this server's slice (see `grantsHash`). */
  readonly grants: GrantMatrix
}

/** A fingerprint together with the state it describes; never one without the other. */
interface FingerprintMemo {
  readonly state: WatchState
  readonly hash: string
}

export function startAgentWatch(deps: AgentWatchDeps): AgentWatch {
  const { record, serverName, store, pollIntervalMs } = deps
  let state: WatchState = { scope: agentScope(record, serverName), grants: record.grants }
  /**
   * Provenance for the gate's decision records (M5): whatever matrix the
   * current scope was derived from is what this fingerprint describes. The
   * WHOLE grant matrix is hashed, not just this server's slice — the record
   * then identifies one version of the agent's authorization as a whole,
   * which is the question an auditor actually asks ("what could this agent do
   * at that moment").
   *
   * Computed LAZILY and memoized against the state it describes (review
   * finding 6). Hashing on every poll canonicalized and hashed the entire
   * matrix — synchronously, on the event loop that gates live traffic, every
   * few seconds per session — whether or not any decision record was going to
   * be written, and most polls write none. The schema permits a matrix that
   * serializes to ~100 MB, so that is a real stall on a real ceiling. Keying
   * the memo on the state OBJECT (not on a boolean) is what makes a stale
   * hash unrepresentable: a swap replaces the state, and the next read misses.
   */
  let memo: FingerprintMemo | null = null
  let timer: NodeJS.Timeout | null = null
  let isStopped = false
  let isPolling = false

  /** The fingerprint of the CURRENT state, computed at most once per state. */
  function grantsHashOfCurrentState(): string {
    if (memo === null || memo.state !== state) {
      memo = { state, hash: grantsHashOf(state.grants) }
    }
    return memo.hash
  }

  const scope: GateAgentScope = Object.freeze({
    agentName: record.name,
    isGranted: (tool: string) => state.scope.isGranted(tool),
    filterVisible: (tools: readonly string[]) => state.scope.filterVisible(tools),
    // The method-grant dimension (M4 Task 6) delegates the same way, so a
    // resources/prompts grant edit takes effect on the next poll, exactly
    // like a tools edit.
    methodGrants: Object.freeze({
      isResourceGranted: (uri: string) => state.scope.methodGrants.isResourceGranted(uri),
      isPromptGranted: (name: string) => state.scope.methodGrants.isPromptGranted(name),
      hasResourcesGrant: () => state.scope.methodGrants.hasResourcesGrant(),
      hasPromptsGrant: () => state.scope.methodGrants.hasPromptsGrant(),
    }),
    // Delegates like everything else on this facade: the gate reads it once
    // per decision record, so an edit picked up by a poll is stamped on the
    // very next record instead of being frozen at session start.
    grantsHash: grantsHashOfCurrentState,
  })

  async function poll(): Promise<void> {
    if (isStopped || isPolling) return
    isPolling = true
    try {
      const fresh = await store.getAgent(record.name)
      if (isStopped) return
      if (fresh === undefined || isRevokedFor(fresh, serverName)) {
        stop()
        deps.onRevoked()
        return
      }
      // Grant edits without a revocation: rebuild the scope so new denials
      // apply from the very next call (and new grants open up likewise).
      // Built first, published second — a throw while deriving the scope
      // leaves the last known-good state whole, and there is no instant at
      // which the new scope is live under the old fingerprint.
      const next: WatchState = { scope: agentScope(fresh, serverName), grants: fresh.grants }
      state = next
    } catch (error: unknown) {
      deps.onError(error)
    } finally {
      isPolling = false
    }
  }

  function start(): void {
    if (isStopped || timer !== null) return
    timer = setInterval(() => {
      void poll()
    }, pollIntervalMs)
    timer.unref()
  }

  function stop(): void {
    isStopped = true
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return { scope, start, stop }
}
