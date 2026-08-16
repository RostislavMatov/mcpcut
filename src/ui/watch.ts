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
 * Seeding: the FIRST poll REPLAYS the whole change feed to rebuild the set of
 * ids that are already pending, and emits nothing — so entries that exist when
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
  /** Read through the existing queue: its delta feed is the only surface used. */
  readonly queue: Pick<ApprovalQueue, 'changesSince'>
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
  /** The one in-flight seed, so overlapping ticks share it instead of racing. */
  let seedInFlight: Promise<void> | null = null
  let quarantineSnapshot: string | null = null
  let handle: IntervalHandle | null = null

  function log(message: string): void {
    stderr.write(`[ui/watch] ${message}\n`)
  }

  /**
   * Seeds by REPLAYING the change feed from its beginning: every row appears
   * exactly once, at its current sequence, so applying `newPending` as an add
   * and `resolvedIds` as a delete rebuilds the pending set EXACTLY — and the
   * last page's watermark is where live polling starts. Nothing is published:
   * a client fetches current state over the JSON API, SSE carries changes.
   *
   * Why not `list()`: it is bounded (`APPROVALS_LIST_MAX_ROWS`) and has no
   * cursor, so on a queue deeper than one page it seeds only the oldest N ids.
   * The rest become visible as the queue drains, but their resolution matched
   * nothing in `announced` and published no `approval-resolved` — the card
   * stayed on an open page until the operator reloaded by hand. Why not
   * `changesSince(null)`: that is a BASELINE by contract (watermark, no rows),
   * so it cannot enumerate anything, and pairing it with a second read was
   * also what made seeding two non-snapshot reads. This is ONE walk of ONE
   * monotonic feed: nothing is derived by comparing two reads.
   *
   * COST, deliberately placed: this runs ONCE, before the first delta, and
   * reads the pending set plus resolved rows still inside their 24h retention
   * (`RESOLVED_FILE_RETENTION_MS`) — in bounded pages, over
   * `idx_approvals_change_seq`. Per POLL nothing changed: still one bounded
   * `changesSince(watermark)` plus the pre-existing drain. The bound exists to
   * keep the POLL proportional to what changed rather than to the backlog, and
   * it still is.
   *
   * The loop is finite by construction (a truncated page strictly advances the
   * watermark) and stops anyway if it ever fails to advance, so a feed that
   * cannot make progress degrades to today's behaviour instead of hanging
   * startup. No page cap: nothing is published until it finishes, so yielding
   * early would only start live polling from an incomplete set — which is the
   * defect being fixed.
   */
  async function seedApprovals(): Promise<void> {
    const seeded = new Set<string>()
    let seq = 0
    for (;;) {
      const page = await deps.queue.changesSince(seq)
      for (const entry of page.newPending) seeded.add(entry.approvalId)
      for (const id of page.resolvedIds) seeded.delete(id)
      if (!page.truncated || page.latestSeq <= seq) {
        seq = Math.max(seq, page.latestSeq)
        break
      }
      seq = page.latestSeq
    }
    watermark = seq
    announced = seeded
  }

  /** One seed per watcher, shared by any ticks that overlap a long replay. */
  function seedOnce(): Promise<void> {
    seedInFlight ??= seedApprovals().finally(() => {
      seedInFlight = null
    })
    return seedInFlight
  }

  async function pollApprovals(): Promise<void> {
    try {
      if (announced === null) {
        await seedOnce()
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
