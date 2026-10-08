import { APPROVAL_HEARTBEAT_INTERVAL_MS, APPROVAL_PROGRESS_INTERVAL_MS } from '../policy/constants.js'
import { heldCallProgress, type SynthesizableId } from './synthesize.js'

/**
 * What runs beside a call held for approval while its agent waits (decision
 * M36): the heartbeat that tells every other process the request is still
 * held (`queue-heartbeat-db.ts`), and — when the client gave the call a
 * `progressToken` and the path can carry the gate's own notifications — a
 * `notifications/progress` at once and then once a minute, so the person sees
 * which approval the call waits for and the client's silence timer never
 * fires (Claude Code moves the call to the background after two minutes and
 * delivers the answer when it settles; smoke 2026-10-08).
 *
 * Both run on an injected scheduler, so tests tick them by hand instead of
 * waiting out real minutes. `stop()` ends both and is called on every way a
 * wait ends; nothing this module sends can follow it.
 */

/** An interval handle we can detach from the event loop; mirrors `NodeJS.Timeout`. */
export interface HoldTimer {
  unref?(): void
}

/** Injectable intervals (the same shape as the UI's heartbeat scheduler). */
export interface HoldScheduler {
  setInterval(callback: () => void, ms: number): HoldTimer
  clearInterval(timer: HoldTimer): void
}

export const DEFAULT_HOLD_SCHEDULER: HoldScheduler = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
}

export interface HoldDeps {
  readonly approvalId: string
  /** The call's `params._meta.progressToken`; absent, the client hears nothing until the answer. */
  readonly progressToken?: SynthesizableId
  /** The text of each progress notification; absent on paths that cannot carry one (HTTP). */
  readonly messageOf?: (approvalId: string) => string
  /** Writes a gate-authored message to the client (the path `answerLocally` uses). */
  readonly send: (bytes: Buffer) => Promise<void>
  readonly heartbeat: () => Promise<void>
  readonly scheduler: HoldScheduler
  readonly onError: (error: unknown) => void
}

export interface Hold {
  stop(): void
}

export function startHold(deps: HoldDeps): Hold {
  const { scheduler } = deps
  let stopped = false
  let progress = 0
  const timers: HoldTimer[] = []

  /** Every tick is a courtesy or a backstop: its failure is reported and never decides the call. */
  function runSafely(work: () => Promise<void>): void {
    if (stopped) return
    try {
      work().catch((error: unknown) => deps.onError(error))
    } catch (error: unknown) {
      deps.onError(error)
    }
  }

  function every(ms: number, callback: () => void): void {
    const timer = scheduler.setInterval(callback, ms)
    timer.unref?.()
    timers.push(timer)
  }

  const { progressToken, messageOf } = deps
  if (progressToken !== undefined && messageOf !== undefined) {
    const sendProgress = (): void =>
      runSafely(() => {
        progress += 1
        return deps.send(heldCallProgress(progressToken, progress, messageOf(deps.approvalId)))
      })
    sendProgress()
    every(APPROVAL_PROGRESS_INTERVAL_MS, sendProgress)
  }
  every(APPROVAL_HEARTBEAT_INTERVAL_MS, () => runSafely(deps.heartbeat))

  return {
    stop() {
      if (stopped) return
      stopped = true
      for (const timer of timers) scheduler.clearInterval(timer)
    },
  }
}
