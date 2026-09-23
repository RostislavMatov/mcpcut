import { describe, expect, test } from 'vitest'
import type { OpenedChildSession } from '../../src/cli/serve-child.js'
import {
  createResidentStarter,
  type OpenStartResult,
  type StartJob,
} from '../../src/cli/serve-residents-start.js'

/**
 * The start queue (BU4): at most two at once, never two of one command line,
 * an awaited start first, and a slot that is only ever counted once.
 */

function job(key: string, commandKey = key): StartJob {
  return {
    key,
    commandKey,
    pair: { agentName: 'bot', agentCreatedAt: 't', serverName: key },
    agent: { name: 'bot' } as StartJob['agent'],
    record: { name: key, transport: 'stdio', command: 'node' } as StartJob['record'],
  }
}

const OPENED = {} as OpenedChildSession

function success(): OpenStartResult {
  return {
    ok: true,
    opened: OPENED,
    discipline: { model: 'sessionful', protocolVersion: '2025-11-25' },
    fingerprint: 'f',
    knownSecrets: [],
  }
}

interface Harness {
  readonly starter: ReturnType<typeof createResidentStarter>
  /** Keys whose open started, in order. */
  readonly started: string[]
  /** Keys running right now. */
  readonly live: Set<string>
  peak: number
  finish(key: string, result?: OpenStartResult): void
  readonly slots: { taken: number; released: number }
  readonly signals: Map<string, AbortSignal>
}

function createHarness(options: { slots?: number } = {}): Harness {
  const pending = new Map<string, (result: OpenStartResult) => void>()
  const slots = { taken: 0, released: 0 }
  const harness: Harness = {
    started: [],
    live: new Set(),
    peak: 0,
    slots,
    signals: new Map(),
    finish: (key, result = success()) => {
      harness.live.delete(key)
      pending.get(key)?.(result)
    },
    starter: createResidentStarter({
      concurrency: 2,
      startTimeoutMs: 40_000,
      now: () => 0,
      reserveSlot: () => {
        if (options.slots !== undefined && slots.taken - slots.released >= options.slots) return null
        slots.taken += 1
        let isReleased = false
        return {
          release: () => {
            if (isReleased) return
            isReleased = true
            slots.released += 1
          },
        }
      },
      openStart: (started, _deadline, signal) => {
        harness.started.push(started.key)
        harness.live.add(started.key)
        harness.peak = Math.max(harness.peak, harness.live.size)
        harness.signals.set(started.key, signal)
        return new Promise((resolve) => pending.set(started.key, resolve))
      },
    }),
  }
  return harness
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('the start queue', () => {
  test('runs at most two at once', async () => {
    // Arrange
    const harness = createHarness()

    // Act
    const results = ['a', 'b', 'c', 'd', 'e'].map((key) => harness.starter.enqueue(job(key)))
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      await settle()
      harness.finish(key)
    }
    await Promise.all(results)

    // Assert
    expect(harness.peak).toBe(2)
    expect(harness.started).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  test('never runs two jobs of one command line in parallel', async () => {
    // Arrange
    const harness = createHarness()
    void harness.starter.enqueue(job('first', 'npx same'))
    void harness.starter.enqueue(job('second', 'npx same'))
    void harness.starter.enqueue(job('other', 'npx other'))
    await settle()

    // Assert — `other` overtook `second`, which waits for `first`.
    expect(harness.started).toEqual(['first', 'other'])

    // Act
    harness.finish('first')
    await settle()

    // Assert
    expect(harness.started).toEqual(['first', 'other', 'second'])
  })

  test('an awaited start jumps the queue', async () => {
    // Arrange
    const harness = createHarness()
    for (const key of ['a', 'b', 'c', 'd']) void harness.starter.enqueue(job(key))
    await settle()

    // Act
    harness.starter.prioritize('d')
    harness.finish('a')
    await settle()

    // Assert
    expect(harness.started).toEqual(['a', 'b', 'd'])
  })

  test('`priority` on enqueue puts a new start first', async () => {
    const harness = createHarness()
    for (const key of ['a', 'b', 'c']) void harness.starter.enqueue(job(key))
    void harness.starter.enqueue(job('urgent'), { priority: true })
    await settle()

    harness.finish('a')
    await settle()

    expect(harness.started).toEqual(['a', 'b', 'urgent'])
  })

  test('the same key queued twice shares one start', async () => {
    const harness = createHarness()

    const first = harness.starter.enqueue(job('a'))
    const second = harness.starter.enqueue(job('a'))
    await settle()
    harness.finish('a')

    expect(await first).toBe(await second)
    expect(harness.started).toEqual(['a'])
  })
})

describe('the slot', () => {
  test('no slot: refused as `no-slot`, and nothing is opened', async () => {
    const harness = createHarness({ slots: 0 })

    const result = await harness.starter.enqueue(job('a'))

    expect(result).toEqual({ ok: false, reason: 'no-slot' })
    expect(harness.started).toEqual([])
  })

  test('a failed start gives its slot back', async () => {
    const harness = createHarness()
    const result = harness.starter.enqueue(job('a'))
    await settle()

    harness.finish('a', { ok: false, reason: 'ended-during-start' })

    expect(await result).toEqual({ ok: false, reason: 'ended-during-start' })
    expect(harness.slots).toEqual({ taken: 1, released: 1 })
  })

  test('a successful start keeps its slot and hands it over', async () => {
    const harness = createHarness()
    const result = harness.starter.enqueue(job('a'))
    await settle()

    harness.finish('a')
    const started = await result

    expect(started.ok).toBe(true)
    expect(harness.slots).toEqual({ taken: 1, released: 0 })
    if (started.ok) started.slot.release()
    expect(harness.slots.released).toBe(1)
  })
})

describe('abortAll', () => {
  test('aborts running starts and refuses queued ones', async () => {
    // Arrange
    const harness = createHarness()
    for (const key of ['a', 'b']) void harness.starter.enqueue(job(key))
    const queued = harness.starter.enqueue(job('c'))
    await settle()

    // Act
    harness.starter.abortAll()

    // Assert
    expect(harness.signals.get('a')?.aborted).toBe(true)
    expect(harness.signals.get('b')?.aborted).toBe(true)
    expect(await queued).toEqual({ ok: false, reason: 'aborted' })
    expect(await harness.starter.enqueue(job('late'))).toEqual({ ok: false, reason: 'aborted' })
  })
})
