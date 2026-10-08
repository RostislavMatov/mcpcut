import { describe, expect, test } from 'vitest'
import { APPROVAL_HEARTBEAT_INTERVAL_MS, APPROVAL_PROGRESS_INTERVAL_MS } from '../../src/policy/constants.js'
import { createHeartbeatTicker, startHold, type HoldScheduler, type HoldTimer } from '../../src/proxy/approval-hold.js'

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

describe('startHold: the progress beside a held call (M36)', () => {
  test('a failing progress write is reported and the hold keeps running', async () => {
    const scheduler = manualScheduler()
    const errors: unknown[] = []
    const sent: Buffer[] = []
    const hold = startHold({
      approvalId: '01A',
      progressToken: 'tok',
      messageOf: (id) => `waiting for approval ${id}`,
      send: (bytes) => {
        sent.push(bytes)
        return sent.length === 1 ? Promise.reject(new Error('client gone')) : Promise.resolve()
      },
      scheduler,
      onError: (error) => errors.push(error),
    })

    scheduler.tick(APPROVAL_PROGRESS_INTERVAL_MS)
    await flush()

    expect(errors.map((error) => (error as Error).message)).toEqual(['client gone'])
    expect(sent).toHaveLength(2)
    expect(scheduler.unrefs).toBe(1) // the hold never keeps a process alive on its own
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
      scheduler: manualScheduler(),
      onError: (error) => errors.push(error),
    }).stop()

    expect(errors.map((error) => (error as Error).message)).toEqual(['bad text'])
  })

  test('stop ends the timer, is idempotent, and nothing is sent after it', () => {
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
      scheduler,
      onError: () => undefined,
    })
    expect(scheduler.active()).toBe(1)

    hold.stop()
    hold.stop()

    expect(scheduler.active()).toBe(0)
    scheduler.tick(APPROVAL_PROGRESS_INTERVAL_MS)
    expect(sent).toHaveLength(1) // only the one sent at once
  })

  test('without a message builder nothing runs at all', () => {
    const scheduler = manualScheduler()
    const sent: Buffer[] = []
    const hold = startHold({
      approvalId: '01A',
      progressToken: 'tok',
      send: (bytes) => {
        sent.push(bytes)
        return Promise.resolve()
      },
      scheduler,
      onError: () => undefined,
    })

    expect(sent).toEqual([])
    expect(scheduler.active()).toBe(0)
    hold.stop()
  })
})

describe('createHeartbeatTicker: one heartbeat per session (review R2)', () => {
  test('runs exactly while calls are held, and each beat writes every held id at once', () => {
    const scheduler = manualScheduler()
    const beats: (readonly string[])[] = []
    const ticker = createHeartbeatTicker({
      heartbeat: (ids) => {
        beats.push(ids)
        return Promise.resolve()
      },
      scheduler,
      onError: () => undefined,
    })
    expect(scheduler.active()).toBe(0)

    ticker.update(['01A'])
    ticker.update(['01A', '01B'])
    expect(scheduler.active()).toBe(1)
    expect(scheduler.unrefs).toBe(1)
    scheduler.tick(APPROVAL_HEARTBEAT_INTERVAL_MS)

    ticker.update([])
    expect(scheduler.active()).toBe(0)
    scheduler.tick(APPROVAL_HEARTBEAT_INTERVAL_MS)
    expect(beats).toEqual([['01A', '01B']])
  })

  test('a failing or throwing write is reported and the ticker keeps running', async () => {
    const scheduler = manualScheduler()
    const errors: unknown[] = []
    let calls = 0
    const ticker = createHeartbeatTicker({
      heartbeat: () => {
        calls += 1
        if (calls === 1) throw new Error('sync boom')
        return Promise.reject(new Error('db locked'))
      },
      scheduler,
      onError: (error) => errors.push(error),
    })
    ticker.update(['01A'])

    scheduler.tick(APPROVAL_HEARTBEAT_INTERVAL_MS)
    scheduler.tick(APPROVAL_HEARTBEAT_INTERVAL_MS)
    await flush()

    expect(errors.map((error) => (error as Error).message)).toEqual(['sync boom', 'db locked'])
    expect(scheduler.active()).toBe(1)
    ticker.update([])
  })
})
