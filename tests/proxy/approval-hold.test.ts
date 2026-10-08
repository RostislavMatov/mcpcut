import { describe, expect, test } from 'vitest'
import { APPROVAL_HEARTBEAT_INTERVAL_MS, APPROVAL_PROGRESS_INTERVAL_MS } from '../../src/policy/constants.js'
import { startHold, type HoldScheduler, type HoldTimer } from '../../src/proxy/approval-hold.js'

/** A scheduler the test ticks by hand. */
function manualScheduler(): HoldScheduler & { tick(ms: number): void; active(): number; unrefs: number } {
  const timers = new Map<HoldTimer, { readonly ms: number; readonly callback: () => void }>()
  const scheduler = {
    unrefs: 0,
    setInterval(callback: () => void, ms: number): HoldTimer {
      const timer: HoldTimer = { unref: () => (scheduler.unrefs += 1) }
      timers.set(timer, { ms, callback })
      return timer
    },
    clearInterval(timer: HoldTimer) {
      timers.delete(timer)
    },
    tick(ms: number) {
      for (const entry of Array.from(timers.values())) if (entry.ms === ms) entry.callback()
    },
    active: () => timers.size,
  }
  return scheduler
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('startHold: what runs beside a held call (M36)', () => {
  test('a failing heartbeat or progress write is reported and the hold keeps running', async () => {
    const scheduler = manualScheduler()
    const errors: unknown[] = []
    const sent: Buffer[] = []
    let beats = 0
    const hold = startHold({
      approvalId: '01A',
      progressToken: 'tok',
      messageOf: (id) => `waiting for approval ${id}`,
      send: (bytes) => {
        sent.push(bytes)
        return sent.length === 1 ? Promise.reject(new Error('client gone')) : Promise.resolve()
      },
      heartbeat: () => {
        beats += 1
        return Promise.reject(new Error('db locked'))
      },
      scheduler,
      onError: (error) => errors.push(error),
    })

    scheduler.tick(APPROVAL_HEARTBEAT_INTERVAL_MS)
    scheduler.tick(APPROVAL_PROGRESS_INTERVAL_MS)
    await flush()

    expect(errors.map((error) => (error as Error).message)).toEqual(['client gone', 'db locked'])
    expect(sent).toHaveLength(2)
    expect(beats).toBe(1)
    expect(scheduler.unrefs).toBe(2) // the hold never keeps a process alive on its own
    hold.stop()
  })

  test('a message builder that throws is reported, not thrown into the gate', () => {
    const errors: unknown[] = []
    startHold({
      approvalId: '01A',
      progressToken: 1,
      messageOf: () => {
        throw new Error('bad text')
      },
      send: () => Promise.resolve(),
      heartbeat: () => Promise.resolve(),
      scheduler: manualScheduler(),
      onError: (error) => errors.push(error),
    }).stop()

    expect(errors.map((error) => (error as Error).message)).toEqual(['bad text'])
  })

  test('stop ends both timers, is idempotent, and nothing is sent after it', () => {
    const scheduler = manualScheduler()
    const sent: Buffer[] = []
    const hold = startHold({
      approvalId: '01A',
      progressToken: 'tok',
      messageOf: (id) => id,
      send: (bytes) => {
        sent.push(bytes)
        return Promise.resolve()
      },
      heartbeat: () => Promise.resolve(),
      scheduler,
      onError: () => undefined,
    })
    expect(scheduler.active()).toBe(2)

    hold.stop()
    hold.stop()

    expect(scheduler.active()).toBe(0)
    scheduler.tick(APPROVAL_PROGRESS_INTERVAL_MS)
    expect(sent).toHaveLength(1) // only the one sent at once
  })

  test('without a message builder (HTTP) only the heartbeat runs', () => {
    const scheduler = manualScheduler()
    const sent: Buffer[] = []
    const hold = startHold({
      approvalId: '01A',
      progressToken: 'tok',
      send: (bytes) => {
        sent.push(bytes)
        return Promise.resolve()
      },
      heartbeat: () => Promise.resolve(),
      scheduler,
      onError: () => undefined,
    })

    expect(sent).toEqual([])
    expect(scheduler.active()).toBe(1)
    hold.stop()
  })
})
