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

    await expect(waitPromise).resolves.toEqual({ outcome: 'approved' })
  })

  test('resolves "denied" once the queue reports a denied resolution', async () => {
    const waiter = createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS })
    const queue = createFakeQueue()

    const waitPromise = waiter.wait(queue, 'approval-1', 5000)
    queue.setResolution({ outcome: 'denied', resolvedAt: new Date().toISOString() })

    await expect(waitPromise).resolves.toEqual({ outcome: 'denied' })
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

    const result = await waitPromise
    clearInterval(advance)

    expect(result).toEqual({ outcome: 'timeout' })
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

    const result = await waitPromise
    clearInterval(advance)
    expect(result).toEqual({ outcome: 'timeout' })

    // Late resolution + more time passing must not change anything: the
    // promise already settled and polling already stopped.
    queue.setResolution({ outcome: 'approved', resolvedAt: new Date().toISOString() })
    const readCountAtSettle = queue.readCount
    await sleep(POLL_INTERVAL_MS * 5)

    expect(queue.readCount).toBe(readCountAtSettle) // no further polling happened
    await expect(waitPromise).resolves.toEqual({ outcome: 'timeout' }) // still the original result
  })

  test('cancelAll immediately settles every in-flight wait with "timeout"', async () => {
    const waiter = createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS })
    const queueA = createFakeQueue()
    const queueB = createFakeQueue()

    const waitA = waiter.wait(queueA, 'approval-a', 60_000)
    const waitB = waiter.wait(queueB, 'approval-b', 60_000)

    waiter.cancelAll()

    await expect(waitA).resolves.toEqual({ outcome: 'timeout' })
    await expect(waitB).resolves.toEqual({ outcome: 'timeout' })
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

  test('an approved resolution surfaces the actor who recorded it', async () => {
    // The gate's terminal record is the only place an auditor learns WHO
    // approved a destructive call, and this is the one component that ever
    // holds the resolution. Dropping the actor here is what made that record
    // unattributable (M5 wave 2).
    const waiter = createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS })
    const queue = createFakeQueue()

    const waitPromise = waiter.wait(queue, 'approval-1', 5000)
    queue.setResolution({ outcome: 'approved', actor: 'ui:alice', resolvedAt: new Date().toISOString() })

    await expect(waitPromise).resolves.toEqual({ outcome: 'approved', actor: 'ui:alice' })
  })

  test('a denial surfaces its actor too', async () => {
    const waiter = createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS })
    const queue = createFakeQueue()

    const waitPromise = waiter.wait(queue, 'approval-1', 5000)
    queue.setResolution({ outcome: 'denied', actor: 'cli', resolvedAt: new Date().toISOString() })

    await expect(waitPromise).resolves.toEqual({ outcome: 'denied', actor: 'cli' })
  })

  test('a resolution with no actor settles with NO actor key, not an undefined one', async () => {
    // Absence must stay expressible: `actor: undefined` and an absent key are
    // indistinguishable after `JSON.stringify`, so only the key's absence can
    // carry "no human is named here" into the journal.
    const waiter = createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS })
    const queue = createFakeQueue()

    const waitPromise = waiter.wait(queue, 'approval-1', 5000)
    queue.setResolution({ outcome: 'approved', resolvedAt: new Date().toISOString() })

    expect(Object.hasOwn(await waitPromise, 'actor')).toBe(false)
  })

  test('an expired resolution never attributes its actor, even when it has one', async () => {
    // `resolve()` downgrades a stale `approved` to `expired` while KEEPING the
    // operator's name for the audit trail. Since every non-approved resolution
    // is reported as a denial, carrying that name over would produce a record
    // reading "alice denied this call" about somebody who approved it.
    const waiter = createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS })
    const queue = createFakeQueue()

    const waitPromise = waiter.wait(queue, 'approval-1', 5000)
    queue.setResolution({ outcome: 'expired', actor: 'ui:alice', resolvedAt: new Date().toISOString() })

    const result = await waitPromise
    expect(result.outcome).toBe('denied')
    expect(Object.hasOwn(result, 'actor')).toBe(false)
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
