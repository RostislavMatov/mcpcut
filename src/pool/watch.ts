import { compareAsText } from '../agents/effective.js'
import type { AgentRecord } from '../agents/schema.js'
import { grantsHashOf } from '../policy/provenance.js'

/**
 * The watch over what a pool CONTAINS (ADR-0015 §10, plan decisions P2/P3).
 *
 * Two things it deliberately does not do.
 *
 * It does not OPEN a server it just saw granted. That stays lazy (PE7): the
 * watch closes what left, tells the agent its list changed, and the next
 * `tools/list` brings the rest up. The metric the PRD asks for — the agent
 * sees a newly granted server without touching its config — is met either
 * way, and this way there is one place that opens children instead of two.
 *
 * It does not use `isRevokedFor`, which asks about ONE server. A pool has no
 * server, so losing a grant is a membership change and the session lives on;
 * only a vanished or revoked AGENT ends it. Conflating the two would close a
 * whole pool because one of its servers was ungranted.
 *
 * What counts as "changed" is the fingerprint of the WHOLE effective matrix,
 * not the list of server names (P2): the catalog an agent sees is filtered by
 * its grants, so narrowing one server's tools changes the visible list just
 * as surely as removing the server does. It is the same fingerprint the
 * decision records already carry, so "what changed" and "what was recorded"
 * look at one thing.
 */

export interface PoolWatchDeps {
  readonly agentName: string
  /** The record the session opened with; its grants are the starting membership. */
  readonly initial: AgentRecord
  /** The one reader of effective grants on the traffic path. */
  readonly readAgent: () => Promise<AgentRecord | undefined>
  readonly pollIntervalMs: number
  /** The agent is gone or revoked: the whole pool session ends. */
  readonly onRevoked: () => void
  /** Membership and/or the grant matrix changed; carries the servers now granted. */
  readonly onChanged: (granted: readonly string[]) => void
  readonly onError: (error: unknown) => void
}

export interface PoolWatch {
  /** Servers the agent is granted right now, sorted. */
  readonly granted: readonly string[]
  start(): void
  /** Stops polling; a poll already in flight can no longer change anything. Idempotent. */
  stop(): void
}

/**
 * What one poll resolved. One immutable object rather than two variables, so
 * a poll swaps membership and fingerprint in a SINGLE assignment — the same
 * discipline as `session/agent-watch.ts`, where two assignments left a window
 * in which one described the other wrongly.
 */
interface PoolWatchState {
  readonly granted: readonly string[]
  readonly hash: string
}

export function createPoolWatch(deps: PoolWatchDeps): PoolWatch {
  let state: PoolWatchState = stateOf(deps.initial)
  let timer: NodeJS.Timeout | null = null
  let isStopped = false
  let isPolling = false

  async function poll(): Promise<void> {
    if (isStopped || isPolling) return
    isPolling = true
    try {
      const fresh = await deps.readAgent()
      if (isStopped) return
      if (fresh === undefined || fresh.revokedAt !== undefined) {
        stop()
        deps.onRevoked()
        return
      }
      // Built first, published second: a throw while deriving leaves the last
      // known-good membership whole.
      const next = stateOf(fresh)
      if (next.hash === state.hash) return
      state = next
      deps.onChanged(next.granted)
    } catch (error: unknown) {
      // Fail closed means "no NEW access", not "less access": a store that is
      // briefly unreadable must not tear an agent's servers away from it.
      deps.onError(error)
    } finally {
      isPolling = false
    }
  }

  function start(): void {
    if (isStopped || timer !== null) return
    timer = setInterval(() => {
      void poll()
    }, deps.pollIntervalMs)
    timer.unref()
  }

  function stop(): void {
    isStopped = true
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return Object.freeze({
    get granted(): readonly string[] {
      return state.granted
    },
    start,
    stop,
  })
}

/**
 * Membership and fingerprint of one record, derived together so one can never
 * describe the other wrongly. `grantsHashOf` canonicalizes before hashing, so
 * a matrix rewritten into a different key or element order is correctly NOT a
 * change — an agent woken for that would have nothing to do about it.
 */
function stateOf(record: AgentRecord): PoolWatchState {
  return {
    granted: Object.keys(record.grants).sort(compareAsText),
    hash: grantsHashOf(record.grants),
  }
}
