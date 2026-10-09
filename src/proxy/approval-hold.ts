import { APPROVAL_HEARTBEAT_INTERVAL_MS, APPROVAL_PROGRESS_INTERVAL_MS } from '../policy/constants.js'
import { heldCallProgress, type SynthesizableId } from './synthesize.js'

/**
 * What runs beside calls held for approval while their agent waits (decision
 * M36): when the client gave a call a `progressToken` and the path can carry
 * the gate's own notifications, a `notifications/progress` at once and then
 * once a minute, so the person sees which approval the call waits for and the
 * client's silence timer never fires (Claude Code moves the call to the
 * background after two minutes and delivers the answer when it settles; smoke
 * 2026-10-08); and, once per SESSION rather than once per call (review R2),
 * the heartbeat that tells every other process the session's requests are
 * still held (`queue-holds-db.ts`).
 *
 * Both run on an injected scheduler, so tests tick them by hand instead of
 * waiting out real minutes. Every way a wait ends stops its progress, and the
 * heartbeat stops with the last held call; nothing either sends can follow.
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
  /** The text of each progress notification; absent on a path that cannot carry one. */
  readonly messageOf?: (approvalId: string) => string
  /** Writes a gate-authored message to the client (the path `answerLocally` uses). */
  readonly send: (bytes: Buffer) => Promise<void>
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

  function runSafely(work: () => Promise<void>): void {
    if (!stopped) runReported(work, deps.onError)
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

  return {
    stop() {
      if (stopped) return
      stopped = true
      for (const timer of timers) scheduler.clearInterval(timer)
    },
  }
}

/** Every tick is a courtesy or a backstop: its failure is reported and never decides the call. */
function runReported(work: () => Promise<void>, onError: (error: unknown) => void): void {
  try {
    work().catch(onError)
  } catch (error: unknown) {
    onError(error)
  }
}

export interface HeartbeatTickerDeps {
  /** One write refreshing every id given (`ApprovalQueue.heartbeat`). */
  readonly heartbeat: (approvalIds: readonly string[]) => Promise<void>
  readonly scheduler: HoldScheduler
  readonly onError: (error: unknown) => void
}

export interface HeartbeatTicker {
  /** The session's held approvals right now; the timer runs exactly while there are any. */
  update(approvalIds: readonly string[]): void
}

/** One heartbeat for a whole session's held calls (review R2): one timer, one write per interval. */
export function createHeartbeatTicker(deps: HeartbeatTickerDeps): HeartbeatTicker {
  let held: readonly string[] = []
  let timer: HoldTimer | undefined

  function beat(): void {
    if (held.length > 0) runReported(() => deps.heartbeat(held), deps.onError)
  }

  return {
    update(approvalIds) {
      held = [...approvalIds]
      if (held.length > 0 && timer === undefined) {
        timer = deps.scheduler.setInterval(beat, APPROVAL_HEARTBEAT_INTERVAL_MS)
        timer.unref?.()
      } else if (held.length === 0 && timer !== undefined) {
        deps.scheduler.clearInterval(timer)
        timer = undefined
      }
    },
  }
}
