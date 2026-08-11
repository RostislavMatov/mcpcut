import type { AgentRecord } from '../agents/schema.js'
import { agentScope, type AgentScope } from '../agents/scope.js'
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
 * A poll that fails to read the store (transient fs error, lockfile
 * contention with a concurrent CLI update) is reported and retried on the
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

export function startAgentWatch(deps: AgentWatchDeps): AgentWatch {
  const { record, serverName, store, pollIntervalMs } = deps
  let currentScope: AgentScope = agentScope(record, serverName)
  let timer: NodeJS.Timeout | null = null
  let isStopped = false
  let isPolling = false

  const scope: GateAgentScope = Object.freeze({
    agentName: record.name,
    isGranted: (tool: string) => currentScope.isGranted(tool),
    filterVisible: (tools: readonly string[]) => currentScope.filterVisible(tools),
    // The method-grant dimension (M4 Task 6) delegates the same way, so a
    // resources/prompts grant edit takes effect on the next poll, exactly
    // like a tools edit.
    methodGrants: Object.freeze({
      isResourceGranted: (uri: string) => currentScope.methodGrants.isResourceGranted(uri),
      isPromptGranted: (name: string) => currentScope.methodGrants.isPromptGranted(name),
      hasResourcesGrant: () => currentScope.methodGrants.hasResourcesGrant(),
      hasPromptsGrant: () => currentScope.methodGrants.hasPromptsGrant(),
    }),
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
      currentScope = agentScope(fresh, serverName)
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
