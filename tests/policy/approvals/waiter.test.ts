import { describe, expect, test, vi } from 'vitest'
import { createApprovalWaiter, type ResolutionSource } from '../../../src/policy/approvals/waiter.js'
import type { ApprovalResolution } from '../../../src/policy/approvals/queue.js'

const POLL_INTERVAL_MS = 5

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A `ResolutionSource` whose answer can be set at any point mid-test. */
function createFakeQueue(): ResolutionSource & { setResolution(resolution: ApprovalResolution | null): void; readCount: number } {
  let resolution: ApprovalResolution | null = null
  let readCount = 0
  return {
    async readResolution() {
      readCount += 1
      return resolution
    },
    setResolution(next) {
      resolution = next
    },
    get readCount() {
      return readCount
    },
  }
}

describe('createApprovalWaiter: wait', () => {
  test('resolves "approved" once the queue reports an approved resolution', async () => {
    const waiter = createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS })
    const queue = createFakeQueue()

    const waitPromise = waiter.wait(queue, 'approval-1', 5000)
    await sleep(POLL_INTERVAL_MS * 2)
    queue.setResolution({ outcome: 'approved', resolvedAt: new Date().toISOString() })

    await expect(waitPromise).resolves.toBe('approved')
  })

  test('resolves "denied" once the queue reports a denied resolution', async () => {
    const waiter = createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS })
    const queue = createFakeQueue()

    const waitPromise = waiter.wait(queue, 'approval-1', 5000)
    queue.setResolution({ outcome: 'denied', resolvedAt: new Date().toISOString() })

    await expect(waitPromise).resolves.toBe('denied')
  })

  test('resolves "timeout" when no resolution arrives before timeoutMs (per injected clock)', async () => {
    let nowMs = 0
    const clock = () => nowMs
    const waiter = createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS, clock })
    const queue = createFakeQueue()

    const waitPromise = waiter.wait(queue, 'approval-1', 20)
    // Advance the injected clock past the deadline while real (short) timers tick.
    const advance = setInterval(() => {
      nowMs += POLL_INTERVAL_MS
    }, POLL_INTERVAL_MS)

    const outcome = await waitPromise
    clearInterval(advance)

    expect(outcome).toBe('timeout')
  })

  test('a resolution that arrives after the timeout does not flip an already-settled "timeout" result', async () => {
    let nowMs = 0
    const clock = () => nowMs
    const waiter = createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS, clock })
    const queue = createFakeQueue()

    const waitPromise = waiter.wait(queue, 'approval-1', 20)
    const advance = setInterval(() => {
      nowMs += POLL_INTERVAL_MS
    }, POLL_INTERVAL_MS)

    const outcome = await waitPromise
    clearInterval(advance)
    expect(outcome).toBe('timeout')

    // Late resolution + more time passing must not change anything: the
    // promise already settled and polling already stopped.
    queue.setResolution({ outcome: 'approved', resolvedAt: new Date().toISOString() })
    const readCountAtSettle = queue.readCount
    await sleep(POLL_INTERVAL_MS * 5)

    expect(queue.readCount).toBe(readCountAtSettle) // no further polling happened
    await expect(waitPromise).resolves.toBe('timeout') // still the original result
  })

  test('cancelAll immediately settles every in-flight wait with "timeout"', async () => {
    const waiter = createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS })
    const queueA = createFakeQueue()
    const queueB = createFakeQueue()

    const waitA = waiter.wait(queueA, 'approval-a', 60_000)
    const waitB = waiter.wait(queueB, 'approval-b', 60_000)

    waiter.cancelAll()

    await expect(waitA).resolves.toBe('timeout')
    await expect(waitB).resolves.toBe('timeout')
  })

  test('cancelAll stops further polling for the cancelled wait', async () => {
    const waiter = createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS })
    const queue = createFakeQueue()

    const waitPromise = waiter.wait(queue, 'approval-1', 60_000)
    await sleep(POLL_INTERVAL_MS * 2)
    waiter.cancelAll()
    await waitPromise

    const readCountAtCancel = queue.readCount
    await sleep(POLL_INTERVAL_MS * 5)

    expect(queue.readCount).toBe(readCountAtCancel)
  })

  test('a resolved wait does not leave a pending timer running', async () => {
    vi.useFakeTimers()
    try {
      const waiter = createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS })
      const queue = createFakeQueue()
      queue.setResolution({ outcome: 'approved', resolvedAt: new Date().toISOString() })

      const waitPromise = waiter.wait(queue, 'approval-1', 5000)
      await vi.advanceTimersByTimeAsync(0)
      await waitPromise

      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
