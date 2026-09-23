import { clientMessage } from '../transport/message.js'
import type { PoolChild } from './children.js'
import type { PoolCorrelator } from './correlator.js'

/**
 * Asking ONE upstream something in the plane's own name, and waiting for its
 * answer (ADR-0015 §3).
 *
 * Two callers need this and neither should own it: the handshake the plane
 * opens to a new child (`handshake.ts`) and the catalog fan-out
 * (`catalog.ts`). Both send a request under a plane-minted id, both must be
 * bounded in time, and both get their reply back through the SAME path —
 * child source → multiplexer → correlator → here.
 *
 * Every failure is `null`, never an exception: a correlation table that is
 * full, an upstream that never answers, and a child that went away in between
 * are all "this server did not answer", which the callers turn into less
 * access rather than a refusal of the whole pool (PE6).
 */

export interface PoolFanoutDeps {
  readonly correlator: PoolCorrelator
  /** How long ONE upstream may take to answer ONE request. */
  readonly timeoutMs: number
  /** The request ran out of time; the caller decides what that costs. */
  readonly onTimeout: (server: string) => void
}

export interface PoolFanout {
  /**
   * Sends `buildLine(id)` to `child` and resolves with the raw reply line, or
   * `null` when none arrived in time (or could not be asked for at all).
   */
  ask(child: PoolChild, tag: string, buildLine: (id: string) => string): Promise<string | null>
  /** Settles a reply; `true` when it belonged to a request still waiting. */
  settle(server: string, id: string, raw: string): boolean
}

/** One request in flight: who it went to, and how to end the wait. */
interface PendingAsk {
  readonly server: string
  resolve(raw: string | null): void
}

export function createPoolFanout(deps: PoolFanoutDeps): PoolFanout {
  const waiting = new Map<string, PendingAsk>()

  /** Ends the wait on `id`, but only for the server it was asked of. */
  function finish(server: string, id: string, raw: string | null): boolean {
    const pending = waiting.get(id)
    // The server check is belt to the correlator's braces: `settle` there
    // already refuses a reply from anyone but the owner. Repeated because a
    // reply credited to the wrong server is the one failure this module could
    // never detect afterwards.
    if (pending === undefined || pending.server !== server) {
      return false
    }
    waiting.delete(id)
    pending.resolve(raw)
    return true
  }

  return Object.freeze({
    async ask(
      child: PoolChild,
      tag: string,
      buildLine: (id: string) => string,
    ): Promise<string | null> {
      // `null` means the correlation table is full — "this server did not
      // answer", not an exception.
      const id = deps.correlator.trackFanout(child.server, tag)
      if (id === null) {
        return null
      }

      let resolve!: (raw: string | null) => void
      const answer = new Promise<string | null>((res) => {
        resolve = res
      })
      // Registered BEFORE the write: an upstream fast enough to answer inside
      // the same turn would otherwise find nobody waiting.
      waiting.set(id, { server: child.server, resolve })
      // Unref'ed: a stalled upstream must not hold the process open.
      const timer = setTimeout(() => finish(child.server, id, null), deps.timeoutMs)
      timer.unref()
      void answer.finally(() => clearTimeout(timer))

      await child.sink.write(clientMessage(Buffer.from(buildLine(id), 'utf8')))
      const raw = await answer
      if (raw === null) {
        deps.onTimeout(child.server)
      }
      return raw
    },

    settle: (server: string, id: string, raw: string): boolean => finish(server, id, raw),
  })
}
