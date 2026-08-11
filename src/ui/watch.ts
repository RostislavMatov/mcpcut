import type { PendingApproval } from '../policy/approvals/queue-file.js'
import type { ApprovalQueue } from '../policy/approvals/queue.js'
import { UI_QUEUE_POLL_INTERVAL_MS } from './constants.js'
import type { IntervalHandle, Scheduler, UiEvent } from './events.js'

/**
 * Single-process watcher for the admin UI (M4 Task 11). It polls the file
 * approvals queue and a caller-supplied quarantine signature every
 * `UI_QUEUE_POLL_INTERVAL_MS`, diffs each against the previous snapshot, and
 * pushes deltas through `publish` (wired to the SSE hub by `ui/server.ts`).
 *
 * Polling, not `fs.watch`: the plan (§3) and M2 both reject `fs.watch` as
 * inconsistent across platforms and network FS. The queue itself is read
 * through the existing `ApprovalQueue.list()` — this module never opens the
 * pending directory directly (no duplicate disk-reading logic).
 *
 * Snapshot seeding: the FIRST poll only records the baseline and emits
 * nothing, so entries that already exist when the UI starts are not replayed
 * as "new" (a freshly attached browser fetches current state over the JSON
 * API; SSE carries only changes from here on). Every subsequent poll diffs.
 *
 * Failure isolation: approvals and quarantine are polled in independent
 * try/catch blocks. A read error on either side is logged and swallowed — it
 * never throws out of `poll()`, never clears subscribers (those live in the
 * hub), and never blocks the other side's delta detection.
 */

/** Stderr-like diagnostics sink; defaults to `process.stderr`. */
export interface WatchStderr {
  write(chunk: string): unknown
}

export interface WatchDeps {
  /** Read through the existing queue; only `list()` is used. */
  readonly queue: Pick<ApprovalQueue, 'list'>
  /**
   * An opaque fingerprint of current quarantine state. `ui/server.ts` derives
   * it from the inventory store; the watcher only compares it for equality, so
   * any stable, change-sensitive string works (and stays testable).
   */
  readonly quarantineSignature: () => Promise<string>
  /** Delta sink; `ui/server.ts` passes `hub.publish`. */
  readonly publish: (event: UiEvent) => void
  readonly scheduler?: Scheduler
  readonly pollIntervalMs?: number
  readonly stderr?: WatchStderr
}

export interface QueueWatcher {
  /** Begins periodic polling. Idempotent: a second call does nothing. */
  start(): void
  /** Stops polling. Idempotent. */
  stop(): void
  /** Runs one poll cycle; exposed for deterministic tests. Never throws. */
  poll(): Promise<void>
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** The display fields the client needs for a new-approval delta (no arg payload). */
function pendingEventData(pending: PendingApproval): Record<string, unknown> {
  return {
    approvalId: pending.approvalId,
    serverName: pending.serverName,
    toolName: pending.toolName,
    toolClass: pending.toolClass,
    sessionId: pending.sessionId,
    requestedAt: pending.requestedAt,
    expiresAt: pending.expiresAt,
    expired: pending.expired,
    ...(pending.agentName !== undefined ? { agentName: pending.agentName } : {}),
    ...(pending.waitExpiresAt !== undefined ? { waitExpiresAt: pending.waitExpiresAt } : {}),
    ...(pending.decisionRule !== undefined ? { decisionRule: pending.decisionRule } : {}),
  }
}

export function createQueueWatcher(deps: WatchDeps): QueueWatcher {
  const scheduler = deps.scheduler
  const pollIntervalMs = deps.pollIntervalMs ?? UI_QUEUE_POLL_INTERVAL_MS
  const stderr: WatchStderr = deps.stderr ?? process.stderr

  let pendingSnapshot: Map<string, PendingApproval> | null = null
  let quarantineSnapshot: string | null = null
  let handle: IntervalHandle | null = null

  function log(message: string): void {
    stderr.write(`[ui/watch] ${message}\n`)
  }

  async function pollApprovals(): Promise<void> {
    let current: readonly PendingApproval[]
    try {
      current = await deps.queue.list()
    } catch (error: unknown) {
      log(`approvals poll failed: ${describeError(error)}`)
      return
    }

    const currentMap = new Map(current.map((entry) => [entry.approvalId, entry]))
    if (pendingSnapshot === null) {
      pendingSnapshot = currentMap // seed, no replay
      return
    }

    for (const [id, entry] of currentMap) {
      if (!pendingSnapshot.has(id)) {
        deps.publish({ event: 'approval-pending', data: pendingEventData(entry) })
      }
    }
    for (const id of pendingSnapshot.keys()) {
      if (!currentMap.has(id)) {
        deps.publish({ event: 'approval-resolved', data: { approvalId: id } })
      }
    }
    pendingSnapshot = currentMap
  }

  async function pollQuarantine(): Promise<void> {
    let signature: string
    try {
      signature = await deps.quarantineSignature()
    } catch (error: unknown) {
      log(`quarantine poll failed: ${describeError(error)}`)
      return
    }

    if (quarantineSnapshot === null) {
      quarantineSnapshot = signature // seed, no replay
      return
    }
    if (signature !== quarantineSnapshot) {
      quarantineSnapshot = signature
      deps.publish({ event: 'quarantine-changed', data: {} })
    }
  }

  async function poll(): Promise<void> {
    // The two sides are independent (separate snapshots, separate try/catch)
    // so they run concurrently; neither can reject, so `Promise.all` is safe.
    await Promise.all([pollApprovals(), pollQuarantine()])
  }

  function scheduleTick(): IntervalHandle {
    const setIntervalFn = scheduler
      ? scheduler.setInterval.bind(scheduler)
      : (cb: () => void, ms: number): IntervalHandle => setInterval(cb, ms)
    return setIntervalFn(() => {
      void poll()
    }, pollIntervalMs)
  }

  function start(): void {
    if (handle !== null) return
    handle = scheduleTick()
    handle.unref?.()
  }

  function stop(): void {
    if (handle === null) return
    if (scheduler) scheduler.clearInterval(handle)
    else clearInterval(handle as unknown as NodeJS.Timeout)
    handle = null
  }

  return Object.freeze({ start, stop, poll })
}
