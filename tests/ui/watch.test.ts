import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { APPROVALS_LIST_MAX_ROWS } from '../../src/config.js'
import { createApprovalQueue } from '../../src/policy/approvals/queue.js'
import {
  createEventHub,
  type IntervalHandle,
  type Scheduler,
  type SseSink,
  type UiEvent,
} from '../../src/ui/events.js'
import { createQueueWatcher, type WatchDeps } from '../../src/ui/watch.js'

let journalDir: string
/** The queue's contract: its directory is nested in the journal dir, whose parent holds state.db. */
let baseDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-ui-watch-test-'))
  baseDir = join(journalDir, 'approvals')
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function enqueueRequest(overrides: Record<string, unknown> = {}) {
  return {
    serverName: 'github',
    toolName: 'create_issue',
    toolClass: 'write' as const,
    args: { title: 'hello' },
    sessionId: 'session-1',
    timeoutMs: 60_000,
    ...overrides,
  }
}

/** Captures published events so a test can assert exact deltas. */
function collector(): { events: UiEvent[]; publish: (event: UiEvent) => void } {
  const events: UiEvent[] = []
  return { events, publish: (event) => events.push(event) }
}

class FakeHandle implements IntervalHandle {
  unrefCalls = 0
  unref(): void {
    this.unrefCalls++
  }
}

class FakeScheduler implements Scheduler {
  readonly intervals: Array<{ cb: () => void; ms: number; handle: FakeHandle }> = []

  setInterval(cb: () => void, ms: number): IntervalHandle {
    const handle = new FakeHandle()
    this.intervals.push({ cb, ms, handle })
    return handle
  }

  clearInterval(handle: IntervalHandle): void {
    const idx = this.intervals.findIndex((i) => i.handle === handle)
    if (idx >= 0) this.intervals.splice(idx, 1)
  }

  get activeCount(): number {
    return this.intervals.length
  }
}

function makeWatcher(overrides: Partial<WatchDeps> = {}) {
  const queue = createApprovalQueue({ baseDir })
  const sink = collector()
  const deps: WatchDeps = {
    queue,
    quarantineSignature: async () => 'const',
    publish: sink.publish,
    ...overrides,
  }
  return { queue, sink, watcher: createQueueWatcher(deps), deps }
}

describe('createQueueWatcher: approval deltas', () => {
  test('a new pending file yields exactly one approval-pending event', async () => {
    const { queue, sink, watcher } = makeWatcher()

    await watcher.poll() // seed baseline (empty)
    const { approvalId } = await queue.enqueue(enqueueRequest())
    await watcher.poll()

    const pendingEvents = sink.events.filter((e) => e.event === 'approval-pending')
    expect(pendingEvents).toHaveLength(1)
    expect(pendingEvents[0]?.data.approvalId).toBe(approvalId)
    expect(pendingEvents[0]?.data.toolName).toBe('create_issue')
  })

  test('a pre-existing pending file is not re-announced on the seed poll', async () => {
    const { queue, sink, watcher } = makeWatcher()
    await queue.enqueue(enqueueRequest())

    await watcher.poll() // seed already contains the entry
    await watcher.poll()

    expect(sink.events.filter((e) => e.event === 'approval-pending')).toHaveLength(0)
  })

  test('resolving a pending entry yields an approval-resolved event with its id', async () => {
    const { queue, sink, watcher } = makeWatcher()
    const { approvalId } = await queue.enqueue(enqueueRequest())

    await watcher.poll() // seed: id present
    await queue.resolve(approvalId, { outcome: 'approved', actor: 'ui' })
    await watcher.poll()

    const resolved = sink.events.filter((e) => e.event === 'approval-resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.data.approvalId).toBe(approvalId)
  })

  test('an entry enqueued and resolved between two polls emits no event at all', async () => {
    const { queue, sink, watcher } = makeWatcher()

    await watcher.poll() // seed baseline (empty)
    const { approvalId } = await queue.enqueue(enqueueRequest())
    await queue.resolve(approvalId, { outcome: 'approved', actor: 'ui' })
    await watcher.poll()

    // Never announced as pending, so its resolution is not announced either:
    // the client is told about changes to what it could have seen, nothing else.
    expect(sink.events.filter((e) => e.event.startsWith('approval'))).toHaveLength(0)
  })

  test('a poll with both a new and a removed entry emits one event of each', async () => {
    const { queue, sink, watcher } = makeWatcher()
    const first = await queue.enqueue(enqueueRequest({ sessionId: 's1' }))

    await watcher.poll() // seed: first present
    await queue.resolve(first.approvalId, { outcome: 'denied' })
    const second = await queue.enqueue(enqueueRequest({ sessionId: 's2' }))
    await watcher.poll()

    expect(sink.events.filter((e) => e.event === 'approval-pending')).toHaveLength(1)
    expect(sink.events.filter((e) => e.event === 'approval-resolved')).toHaveLength(1)
    expect(
      sink.events.find((e) => e.event === 'approval-pending')?.data.approvalId,
    ).toBe(second.approvalId)
  })
})

describe('createQueueWatcher: queues deeper than one bounded read', () => {
  /**
   * One more request than a single bounded read can return, so the LAST id is
   * provably outside the first page. 501 enqueues cost ~80ms against the real
   * queue (measured), so this is generated for real rather than faked: the
   * defect is exactly about the queue's own row bound, and a fake queue with a
   * smaller bound would be testing the fake's arithmetic.
   */
  const DEEP_QUEUE_SIZE = APPROVALS_LIST_MAX_ROWS + 1

  async function fillDeepQueue(queue: ReturnType<typeof createApprovalQueue>): Promise<string[]> {
    const ids: string[] = []
    for (let i = 0; i < DEEP_QUEUE_SIZE; i += 1) {
      const { approvalId } = await queue.enqueue(enqueueRequest({ sessionId: `s${i}` }))
      ids.push(approvalId)
    }
    return ids
  }

  /**
   * The id a bounded listing cannot show, ASKED OF THE LISTING rather than
   * assumed: `list()` orders by `(requestedAt, approvalId)`, and 501 enqueues
   * share so few milliseconds that the tie-break is the random half of a ULID —
   * so "the one enqueued last" is not reliably the one left out.
   */
  async function idBeyondFirstPage(
    queue: ReturnType<typeof createApprovalQueue>,
    ids: readonly string[],
  ): Promise<string> {
    const listed = await queue.list()
    expect(listed).toHaveLength(APPROVALS_LIST_MAX_ROWS)
    const shown = new Set(listed.map((entry) => entry.approvalId))
    const hidden = ids.find((id) => !shown.has(id))
    expect(hidden).toBeDefined()
    return hidden as string
  }

  test('resolving a request beyond the first page still yields approval-resolved', async () => {
    const { queue, sink, watcher } = makeWatcher()
    const ids = await fillDeepQueue(queue)
    const beyondFirstPage = await idBeyondFirstPage(queue, ids)

    await watcher.poll() // seed
    await queue.resolve(beyondFirstPage, { outcome: 'approved', actor: 'ui' })
    await watcher.poll()

    const resolved = sink.events.filter((e) => e.event === 'approval-resolved')
    expect(resolved.map((e) => e.data.approvalId)).toEqual([beyondFirstPage])
  })

  test('attaching to a queue deeper than one page replays no pending events', async () => {
    const { queue, sink, watcher } = makeWatcher()
    await fillDeepQueue(queue)

    await watcher.poll() // seed walks every page and must announce nothing
    await watcher.poll()

    expect(sink.events.filter((e) => e.event.startsWith('approval'))).toHaveLength(0)
  })

  test('a resolve beyond the first page is announced once, not once per poll', async () => {
    const { queue, sink, watcher } = makeWatcher()
    const ids = await fillDeepQueue(queue)
    const beyondFirstPage = await idBeyondFirstPage(queue, ids)

    await watcher.poll() // seed
    await queue.resolve(beyondFirstPage, { outcome: 'denied' })
    await watcher.poll()
    await watcher.poll()
    await watcher.poll()

    expect(sink.events.filter((e) => e.event === 'approval-resolved')).toHaveLength(1)
  })

  test('an enqueue past the first page is announced as pending exactly once', async () => {
    const { queue, sink, watcher } = makeWatcher()
    await fillDeepQueue(queue)

    await watcher.poll() // seed
    const { approvalId } = await queue.enqueue(enqueueRequest({ sessionId: 'late' }))
    await watcher.poll()
    await watcher.poll()

    const pending = sink.events.filter((e) => e.event === 'approval-pending')
    expect(pending.map((e) => e.data.approvalId)).toEqual([approvalId])
  })
})

describe('createQueueWatcher: quarantine deltas', () => {
  test('a changed quarantine signature yields a quarantine-changed event', async () => {
    let signature = 'v1'
    const { sink, watcher } = makeWatcher({ quarantineSignature: async () => signature })

    await watcher.poll() // seed
    signature = 'v2'
    await watcher.poll()

    expect(sink.events.filter((e) => e.event === 'quarantine-changed')).toHaveLength(1)
  })

  test('an unchanged quarantine signature emits nothing', async () => {
    const { sink, watcher } = makeWatcher({ quarantineSignature: async () => 'stable' })

    await watcher.poll()
    await watcher.poll()

    expect(sink.events.filter((e) => e.event === 'quarantine-changed')).toHaveLength(0)
  })
})

describe('createQueueWatcher: resilience', () => {
  test('a directory read error is logged and the poll neither throws nor emits', async () => {
    const lines: string[] = []
    const fail = async (): Promise<never> => {
      throw new Error('EIO: simulated directory read failure')
    }
    const failingQueue = { list: fail, changesSince: fail }
    const sink = collector()
    const watcher = createQueueWatcher({
      queue: failingQueue,
      quarantineSignature: async () => 'const',
      publish: sink.publish,
      stderr: { write: (chunk: string) => lines.push(chunk) },
    })

    await expect(watcher.poll()).resolves.toBeUndefined()
    expect(sink.events.filter((e) => e.event.startsWith('approval'))).toHaveLength(0)
    expect(lines.join('')).toMatch(/simulated directory read failure/)
  })

  test('a quarantine read error does not block approval delta detection', async () => {
    const { queue, sink, watcher } = makeWatcher({
      quarantineSignature: async () => {
        throw new Error('quarantine store unreadable')
      },
      stderr: { write: () => undefined },
    })

    await watcher.poll()
    await queue.enqueue(enqueueRequest())
    await watcher.poll()

    expect(sink.events.filter((e) => e.event === 'approval-pending')).toHaveLength(1)
  })
})

describe('createQueueWatcher: timers', () => {
  test('start schedules polling at UI_QUEUE_POLL_INTERVAL_MS and unrefs the timer', () => {
    const scheduler = new FakeScheduler()
    const { watcher } = makeWatcher({ scheduler })

    watcher.start()

    expect(scheduler.intervals[0]?.ms).toBe(1000)
    expect(scheduler.intervals[0]?.handle.unrefCalls).toBeGreaterThanOrEqual(1)
  })

  test('stop clears the polling timer', () => {
    const scheduler = new FakeScheduler()
    const { watcher } = makeWatcher({ scheduler })

    watcher.start()
    watcher.stop()

    expect(scheduler.activeCount).toBe(0)
  })

  test('start is idempotent: it never stacks a second interval', () => {
    const scheduler = new FakeScheduler()
    const { watcher } = makeWatcher({ scheduler })

    watcher.start()
    watcher.start()

    expect(scheduler.activeCount).toBe(1)
  })
})

describe('createQueueWatcher: latency budget', () => {
  test('an enqueue is announced within a single poll interval to every subscriber', async () => {
    const scheduler = new FakeScheduler()
    const hub = createEventHub({ scheduler })
    const queue = createApprovalQueue({ baseDir })
    const watcher = createQueueWatcher({
      queue,
      quarantineSignature: async () => 'const',
      publish: (event) => hub.publish(event),
      scheduler,
      pollIntervalMs: 1000,
    })

    // Two subscribers attached to the same hub.
    const written: string[][] = [[], []]
    for (const chunks of written) {
      const sink: SseSink = {
        writeHead: () => undefined,
        write: (chunk: string) => {
          chunks.push(chunk)
          return true
        },
        end: () => undefined,
        on: () => undefined,
      }
      hub.subscribe(sink)
    }

    await watcher.poll() // seed, empty
    const { approvalId } = await queue.enqueue(enqueueRequest())
    // The very next poll cycle (<= pollIntervalMs later) must announce it.
    await watcher.poll()

    for (const chunks of written) {
      const joined = chunks.join('')
      expect(joined).toContain('event: approval-pending')
      expect(joined).toContain(approvalId)
    }
  })
})
