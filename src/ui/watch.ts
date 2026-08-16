import type { PendingApproval } from '../policy/approvals/queue-file.js'
import type { ApprovalQueue } from '../policy/approvals/queue.js'
import { UI_QUEUE_DRAIN_MAX_PAGES, UI_QUEUE_POLL_INTERVAL_MS } from './constants.js'
import type { IntervalHandle, Scheduler, UiEvent } from './events.js'

/**
 * Single-process watcher for the admin UI (M4 Task 11). It polls the approvals
 * queue and a caller-supplied quarantine signature every
 * `UI_QUEUE_POLL_INTERVAL_MS` and pushes deltas through `publish` (wired to the
 * SSE hub by `ui/server.ts`).
 *
 * Polling, not `fs.watch`: the plan (§3) and M2 both reject `fs.watch` as
 * inconsistent across platforms and network FS. The queue itself is read
 * through `ApprovalQueue.changesSince()` — an indexed "what changed since this
 * sequence" read (M4.5 wave 3), not a re-read of the whole pending set every
 * tick — so this module never touches the queue's storage directly.
 *
 * Seeding: the FIRST poll only takes a baseline (the current sequence plus the
 * ids already pending) and emits nothing, so entries that already exist when
 * the UI starts are not replayed as "new" (a freshly attached browser fetches
 * current state over the JSON API; SSE carries only changes from here on).
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
  /** Read through the existing queue: a baseline `list()` plus its delta feed. */
  readonly queue: Pick<ApprovalQueue, 'list' | 'changesSince'>
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

  /** Ids this watcher has announced as pending; `null` until the seed poll runs. */
  let announced: Set<string> | null = null
  let watermark = 0
  let quarantineSnapshot: string | null = null
  let handle: IntervalHandle | null = null

  function log(message: string): void {
    stderr.write(`[ui/watch] ${message}\n`)
  }

  /**
   * Seeds from a BASELINE (`changesSince(null)`) plus one `list()`: the
   * baseline fixes the watermark without replaying anything, and the listing
   * gives the set of ids that are already pending — so a later resolve of one
   * of them is still recognized as a retraction of something the client may
   * have fetched over the JSON API.
   *
   * KNOWN, ACCEPTED GAP (reviewed 2026-08-16, decided "document, do not fix"):
   * the two reads are not one snapshot. A request that was already pending and
   * gets resolved BETWEEN them lands in neither — it is gone from `list()`, so
   * it never enters `announced`, and its change is below the baseline
   * watermark, so no `approval-resolved` event is published for it. The window
   * is sub-millisecond and exists only at UI startup, and the client refetches
   * the list over the JSON API on load, so the page self-heals on its first
   * render. Closing it properly means reading both under one transaction, which
   * would put a queue-wide read lock on the startup path to fix a stale row
   * that no one sees.
   */
  async function seedApprovals(): Promise<void> {
    const baseline = await deps.queue.changesSince(null)
    const current = await deps.queue.list()
    watermark = baseline.latestSeq
    announced = new Set(current.map((entry) => entry.approvalId))
  }

  async function pollApprovals(): Promise<void> {
    try {
      if (announced === null) {
        await seedApprovals()
        return
      }

      // Drain: a bounded read can leave more behind, and its watermark stops at
      // the last change it delivered. Looping until the feed is caught up keeps
      // a backlog from taking one poll interval per page to work through, while
      // the bound still keeps any single read cheap.
      //
      // Two independent stops. The loop is finite by construction — each page
      // strictly advances the watermark — but a writer faster than the drain
      // could keep producing pages and hold this tick for an unbounded stretch
      // of wall clock. The page cap yields back to the event loop; nothing is
      // lost, because the watermark has already moved past what was delivered.
      let pages = 0
      let changes = await deps.queue.changesSince(watermark)
      watermark = changes.latestSeq
      publishApprovalDeltas(announced, changes.newPending, changes.resolvedIds)
      while (changes.truncated && pages < UI_QUEUE_DRAIN_MAX_PAGES) {
        pages += 1
        changes = await deps.queue.changesSince(watermark)
        watermark = changes.latestSeq
        publishApprovalDeltas(announced, changes.newPending, changes.resolvedIds)
      }
    } catch (error: unknown) {
      log(`approvals poll failed: ${describeError(error)}`)
    }
  }

  /**
   * The announced set is what makes a re-delivered change harmless (the feed
   * is at-least-once) AND keeps the old snapshot-diff behaviour: a request
   * that was enqueued and resolved between two polls was never announced, so
   * its resolution is not announced either.
   */
  function publishApprovalDeltas(
    seen: Set<string>,
    newPending: readonly PendingApproval[],
    resolvedIds: readonly string[],
  ): void {
    for (const entry of newPending) {
      if (seen.has(entry.approvalId)) continue
      seen.add(entry.approvalId)
      deps.publish({ event: 'approval-pending', data: pendingEventData(entry) })
    }
    for (const id of resolvedIds) {
      if (!seen.delete(id)) continue
      deps.publish({ event: 'approval-resolved', data: { approvalId: id } })
    }
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
