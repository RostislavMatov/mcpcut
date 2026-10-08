import { cleanWithdrawReason } from '../policy/approvals/withdraw.js'
import type { JsonRpcId } from '../protocol/classify.js'
import type { Departure, DepartureKind } from './gate-delivery.js'
import type { Verdict } from './pipeline.js'
import { DROP, FORWARD, idKeyOf, isPromiseVerdict, parseCancelledReason, parseCancelledRequestId } from './gate-helpers.js'

/**
 * The client's `notifications/cancelled`, as the router handles it. Split out
 * of `gate-router.ts` for the <400-line file rule when decision M36 gave the
 * cancel a second job.
 *
 * A cancel is ordered strictly behind the verdict of the request it cancels
 * (TS-M2): the server must see the `tools/call` before its cancellation to
 * correlate them. Since M36 a request that never reached the server — its
 * agent left and the held call was withdrawn, or it was denied or refused —
 * takes its cancel with it: the server never saw the call, so it must not see
 * a cancel for it either. And the cancel is announced (`onClientCancelled`)
 * before it is ordered, so a call held for a confirmation or an admin's
 * approval stops waiting at once.
 */

export interface CancelTrackerDeps {
  /** Remembers an in-flight verdict so `cancelPending()` can wait it out. */
  readonly track: (work: Verdict | Promise<Verdict>) => Verdict | Promise<Verdict>
  /** Hears each cancel (or abandonment) with its cleaned reason (see `GateRouterDeps.onClientCancelled`). */
  readonly onClientCancelled?: (idKey: string, reason: string, kind: DepartureKind) => void | Promise<void>
  readonly onError: (error: unknown) => void
}

export interface CancelTracker {
  /** Records an in-flight tool-call verdict by request id, so a cancel can queue behind it. */
  recordVerdict(id: JsonRpcId, verdict: Verdict | Promise<Verdict>): Verdict | Promise<Verdict>
  /** The verdict for one `notifications/cancelled` (raw JSON text). */
  gateCancel(raw: string): Verdict | Promise<Verdict>
  /**
   * The agent stopped waiting for `idKey` without a cancel (phase B: its HTTP
   * request closed). Heard like a cancel by whatever holds the call — a held
   * approval is withdrawn, an open confirmation refused — but nothing is
   * forwarded: a dropped connection is not a cancellation (MCP), so a call
   * already sent is left to finish.
   */
  abandon(idKey: string, reason: string): void
  /** The reason of a cancel (or abandonment) for `idKey` while that request's verdict is still in flight. */
  cancelReasonOf(idKey: string): string | undefined
  /** The same, with whether the server was told (a cancel) or not (an abandonment) — phase C. */
  departureOf(idKey: string): Departure | undefined
}

export function createCancelTracker(deps: CancelTrackerDeps): CancelTracker {
  const verdictsByRequestId = new Map<string, Promise<Verdict>>()
  const cancelledInFlight = new Map<string, Departure>()

  function recordVerdict(id: JsonRpcId, verdict: Verdict | Promise<Verdict>): Verdict | Promise<Verdict> {
    if (id === null || !isPromiseVerdict(verdict)) return verdict
    const key = idKeyOf(id)
    const settled = Promise.resolve(verdict)
    verdictsByRequestId.set(key, settled)
    void settled.finally(() => {
      if (verdictsByRequestId.get(key) !== settled) return
      verdictsByRequestId.delete(key)
      cancelledInFlight.delete(key)
    })
    return verdict
  }

  /** Notes the agent left `key` (for a call not queued yet) and tells whatever holds it. */
  function announce(key: string, reason: string, kind: DepartureKind): Promise<Verdict> | undefined {
    const pending = verdictsByRequestId.get(key)
    if (pending !== undefined) cancelledInFlight.set(key, Object.freeze({ reason, kind }))
    try {
      void Promise.resolve(deps.onClientCancelled?.(key, reason, kind)).catch(deps.onError)
    } catch (error: unknown) {
      deps.onError(error)
    }
    return pending
  }

  function gateCancel(raw: string): Verdict | Promise<Verdict> {
    const requestId = parseCancelledRequestId(raw)
    if (requestId === null) return FORWARD
    const pending = announce(idKeyOf(requestId), cleanWithdrawReason(parseCancelledReason(raw)), 'cancel')
    if (pending === undefined) return FORWARD
    return deps.track(pending.then((verdict) => (verdict.action === 'forward' ? FORWARD : DROP), () => FORWARD))
  }

  return {
    recordVerdict,
    gateCancel,
    abandon: (idKey, reason) => void announce(idKey, reason, 'abandon'),
    cancelReasonOf: (idKey) => cancelledInFlight.get(idKey)?.reason,
    departureOf: (idKey) => cancelledInFlight.get(idKey),
  }
}
