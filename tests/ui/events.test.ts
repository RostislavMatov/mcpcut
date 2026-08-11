import type { ServerResponse } from 'node:http'
import { describe, expect, test } from 'vitest'
import {
  createEventHub,
  type IntervalHandle,
  type Scheduler,
  type SseSink,
  type UiEvent,
} from '../../src/ui/events.js'
import { createEventsHandler } from '../../src/ui/handlers/events.js'

/**
 * A ServerResponse-shaped test double: the hub only ever touches `writeHead`,
 * `write`, `end`, `on('close')` and `writableEnded`, so a fake covering those
 * is enough to drive fan-out, capacity and teardown deterministically.
 */
class FakeSink implements SseSink {
  status?: number
  headers?: Record<string, string>
  readonly chunks: string[] = []
  ended = false
  writableEnded = false
  private readonly closeListeners: Array<() => void> = []

  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status
    this.headers = headers
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }

  end(): void {
    this.ended = true
    this.writableEnded = true
  }

  on(event: 'close', listener: () => void): void {
    if (event === 'close') this.closeListeners.push(listener)
  }

  /** Simulates the peer dropping the connection. */
  emitClose(): void {
    this.writableEnded = true
    for (const listener of this.closeListeners) listener()
  }

  get closeListenerCount(): number {
    return this.closeListeners.length
  }

  get written(): string {
    return this.chunks.join('')
  }
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

  tickAll(): void {
    for (const interval of [...this.intervals]) interval.cb()
  }

  get activeCount(): number {
    return this.intervals.length
  }
}

const PENDING_EVENT: UiEvent = {
  event: 'approval-pending',
  data: { approvalId: '01ABC', serverName: 'github', toolName: 'create_issue' },
}

describe('createEventHub: subscription and headers', () => {
  // Contract change (SSE-seam fix): the hub no longer writes the response
  // status/headers — `server.ts` writes the single SSE `writeHead(200, …)` with
  // security headers before `subscribe` runs. The hub only registers the sink.
  test('subscribe registers the sink and returns ok without writing headers', () => {
    const hub = createEventHub({ scheduler: new FakeScheduler() })
    const sink = new FakeSink()

    const result = hub.subscribe(sink)

    expect(result.ok).toBe(true)
    expect(sink.status).toBeUndefined()
    expect(sink.headers).toBeUndefined()
    expect(sink.closeListenerCount).toBe(1)
    expect(hub.subscriberCount()).toBe(1)
  })

  test('hasCapacity is true below the cap, false at the cap and after close', () => {
    const hub = createEventHub({ scheduler: new FakeScheduler(), maxSubscribers: 1 })

    expect(hub.hasCapacity()).toBe(true)
    hub.subscribe(new FakeSink())
    expect(hub.hasCapacity()).toBe(false)

    const openHub = createEventHub({ scheduler: new FakeScheduler() })
    expect(openHub.hasCapacity()).toBe(true)
    openHub.close()
    expect(openHub.hasCapacity()).toBe(false)
  })
})

describe('createEventHub: fan-out', () => {
  test('publish delivers one named event to every subscriber', () => {
    const hub = createEventHub({ scheduler: new FakeScheduler() })
    const a = new FakeSink()
    const b = new FakeSink()
    hub.subscribe(a)
    hub.subscribe(b)

    hub.publish(PENDING_EVENT)

    const expected = `event: approval-pending\ndata: ${JSON.stringify(PENDING_EVENT.data)}\n\n`
    expect(a.written).toContain(expected)
    expect(b.written).toContain(expected)
    // Exactly one occurrence per subscriber.
    expect(a.written.split('event: approval-pending').length - 1).toBe(1)
    expect(b.written.split('event: approval-pending').length - 1).toBe(1)
  })
})

describe('createEventHub: heartbeat', () => {
  test('heartbeat is scheduled at the configured interval and writes a comment', () => {
    const scheduler = new FakeScheduler()
    const hub = createEventHub({ scheduler, heartbeatIntervalMs: 15_000 })
    const sink = new FakeSink()
    hub.subscribe(sink)

    expect(scheduler.intervals[0]?.ms).toBe(15_000)

    scheduler.tickAll()

    expect(sink.written).toContain(':')
    expect(sink.written.endsWith('\n\n')).toBe(true)
  })

  test('the heartbeat timer is unref-ed so it never holds the process open', () => {
    const scheduler = new FakeScheduler()
    createEventHub({ scheduler })

    expect(scheduler.intervals[0]?.handle.unrefCalls).toBeGreaterThanOrEqual(1)
  })
})

describe('createEventHub: subscriber cap', () => {
  test('subscribing past the cap is refused without writing headers', () => {
    const hub = createEventHub({ scheduler: new FakeScheduler(), maxSubscribers: 2 })
    const a = new FakeSink()
    const b = new FakeSink()
    const c = new FakeSink()

    expect(hub.subscribe(a).ok).toBe(true)
    expect(hub.subscribe(b).ok).toBe(true)
    const third = hub.subscribe(c)

    expect(third).toEqual({ ok: false, reason: 'at-capacity' })
    expect(c.status).toBeUndefined()
    expect(hub.subscriberCount()).toBe(2)
  })
})

describe('createEventHub: teardown and leaks', () => {
  test('closing the peer socket removes the subscription and later publishes skip it', () => {
    const hub = createEventHub({ scheduler: new FakeScheduler() })
    const sink = new FakeSink()
    hub.subscribe(sink)
    expect(sink.closeListenerCount).toBe(1)

    sink.emitClose()

    expect(hub.subscriberCount()).toBe(0)
    const before = sink.chunks.length
    hub.publish(PENDING_EVENT)
    expect(sink.chunks.length).toBe(before)
  })

  test('a freed slot can be reused after a subscriber drops', () => {
    const hub = createEventHub({ scheduler: new FakeScheduler(), maxSubscribers: 1 })
    const a = new FakeSink()
    const b = new FakeSink()

    expect(hub.subscribe(a).ok).toBe(true)
    a.emitClose()
    expect(hub.subscribe(b).ok).toBe(true)
    expect(hub.subscriberCount()).toBe(1)
  })

  test('close ends every stream, clears the heartbeat and empties the roster', () => {
    const scheduler = new FakeScheduler()
    const hub = createEventHub({ scheduler })
    const a = new FakeSink()
    const b = new FakeSink()
    hub.subscribe(a)
    hub.subscribe(b)

    hub.close()

    expect(a.ended).toBe(true)
    expect(b.ended).toBe(true)
    expect(hub.subscriberCount()).toBe(0)
    expect(scheduler.activeCount).toBe(0)
  })

  test('publish after close is a no-op', () => {
    const hub = createEventHub({ scheduler: new FakeScheduler() })
    const sink = new FakeSink()
    hub.subscribe(sink)
    hub.close()
    const before = sink.chunks.length

    hub.publish(PENDING_EVENT)

    expect(sink.chunks.length).toBe(before)
  })
})

describe('createEventHub: session-bound streams (HIGH-2)', () => {
  const ALICE = { sessionId: 'sid-alice-1', adminName: 'alice' }
  const ALICE_2 = { sessionId: 'sid-alice-2', adminName: 'alice' }
  const BOB = { sessionId: 'sid-bob-1', adminName: 'bob' }

  test('closeSession ends exactly the streams opened under that session id', () => {
    const hub = createEventHub({ scheduler: new FakeScheduler() })
    const alice1 = new FakeSink()
    const alice2 = new FakeSink()
    const bob = new FakeSink()
    hub.subscribe(alice1, ALICE)
    hub.subscribe(alice2, ALICE_2)
    hub.subscribe(bob, BOB)

    expect(hub.closeSession(ALICE.sessionId)).toBe(1)

    expect(alice1.ended).toBe(true)
    expect(alice2.ended).toBe(false)
    expect(bob.ended).toBe(false)
    expect(hub.subscriberCount()).toBe(2)
  })

  test('closeForAdmin ends every stream of that admin and leaves the others open', () => {
    const hub = createEventHub({ scheduler: new FakeScheduler() })
    const alice1 = new FakeSink()
    const alice2 = new FakeSink()
    const bob = new FakeSink()
    hub.subscribe(alice1, ALICE)
    hub.subscribe(alice2, ALICE_2)
    hub.subscribe(bob, BOB)

    expect(hub.closeForAdmin('alice')).toBe(2)

    expect(alice1.ended).toBe(true)
    expect(alice2.ended).toBe(true)
    expect(bob.ended).toBe(false)
    expect(hub.subscriberCount()).toBe(1)
  })

  test('the sweep ends streams whose session no longer resolves and keeps live ones', async () => {
    const live = new Set([BOB.sessionId])
    const hub = createEventHub({
      scheduler: new FakeScheduler(),
      isSessionLive: (identity) => live.has(identity.sessionId),
    })
    const alice = new FakeSink()
    const bob = new FakeSink()
    hub.subscribe(alice, ALICE)
    hub.subscribe(bob, BOB)

    expect(await hub.sweepSessions()).toBe(1)

    expect(alice.ended).toBe(true)
    expect(bob.ended).toBe(false)
    expect(hub.subscriberCount()).toBe(1)
  })

  test('the sweep is fail-closed: a stream with no identity is ended when a probe is configured', async () => {
    const hub = createEventHub({ scheduler: new FakeScheduler(), isSessionLive: () => true })
    const anonymous = new FakeSink()
    hub.subscribe(anonymous)

    expect(await hub.sweepSessions()).toBe(1)

    expect(anonymous.ended).toBe(true)
    expect(hub.subscriberCount()).toBe(0)
  })

  test('without a probe the sweep is a no-op (unit-test and no-session-binding use)', async () => {
    const hub = createEventHub({ scheduler: new FakeScheduler() })
    const sink = new FakeSink()
    hub.subscribe(sink, ALICE)

    expect(await hub.sweepSessions()).toBe(0)

    expect(sink.ended).toBe(false)
  })

  test('a probe that throws is treated as "not live" (fail-closed)', async () => {
    const hub = createEventHub({
      scheduler: new FakeScheduler(),
      isSessionLive: () => {
        throw new Error('store unreadable')
      },
    })
    const sink = new FakeSink()
    hub.subscribe(sink, ALICE)

    expect(await hub.sweepSessions()).toBe(1)

    expect(sink.ended).toBe(true)
  })

  test('each heartbeat tick runs a sweep', async () => {
    const scheduler = new FakeScheduler()
    const probed: string[] = []
    const hub = createEventHub({
      scheduler,
      isSessionLive: (identity) => {
        probed.push(identity.sessionId)
        return true
      },
    })
    hub.subscribe(new FakeSink(), ALICE)

    scheduler.tickAll()
    await hub.sweepSessions()

    expect(probed).toContain(ALICE.sessionId)
    expect(hub.subscriberCount()).toBe(1)
  })

  test('N subscribers sharing a session trigger one probe per sweep', async () => {
    const probeCalls: string[] = []
    const hub = createEventHub({
      scheduler: new FakeScheduler(),
      isSessionLive: (identity) => {
        probeCalls.push(identity.sessionId)
        return true
      },
    })
    hub.subscribe(new FakeSink(), ALICE)
    hub.subscribe(new FakeSink(), ALICE)
    hub.subscribe(new FakeSink(), ALICE)

    expect(await hub.sweepSessions()).toBe(0)

    expect(probeCalls).toEqual([ALICE.sessionId])
    expect(hub.subscriberCount()).toBe(3)
  })

  test('closeSession and closeForAdmin are no-ops for an unknown key', () => {
    const hub = createEventHub({ scheduler: new FakeScheduler() })
    const sink = new FakeSink()
    hub.subscribe(sink, ALICE)

    expect(hub.closeSession('nope')).toBe(0)
    expect(hub.closeForAdmin('nobody')).toBe(0)
    expect(sink.ended).toBe(false)
    expect(hub.subscriberCount()).toBe(1)
  })
})

describe('createEventsHandler: GET /events', () => {
  // Contract change (SSE-seam fix): the handler now returns a `UiResult` like
  // every other injected handler and NEVER touches `res` directly. The server
  // writes the SSE `200` once and calls `onStream`, which subscribes.
  test('with capacity it returns a stream whose onStream subscribes to the hub', async () => {
    const hub = createEventHub({ scheduler: new FakeScheduler() })
    const handler = createEventsHandler(hub)
    const sink = new FakeSink()

    const result = await handler({} as never)

    expect(result.kind).toBe('stream')
    if (result.kind !== 'stream') throw new Error('expected a stream result')
    // The handler wrote nothing; only onStream (called by the server) subscribes.
    expect(hub.subscriberCount()).toBe(0)
    result.onStream(sink as unknown as ServerResponse)
    expect(hub.subscriberCount()).toBe(1)
    expect(sink.status).toBeUndefined()
    expect(sink.ended).toBe(false)
  })

  test('past the subscriber cap it returns a 503 response with Retry-After, no stream', async () => {
    const hub = createEventHub({ scheduler: new FakeScheduler(), maxSubscribers: 1 })
    const handler = createEventsHandler(hub)
    const first = await handler({} as never)
    if (first.kind !== 'stream') throw new Error('expected a stream result')
    first.onStream(new FakeSink() as unknown as ServerResponse)

    const result = await handler({} as never)

    expect(result.kind).toBe('response')
    if (result.kind !== 'response') throw new Error('expected a response result')
    expect(result.status).toBe(503)
    expect(result.headers?.['retry-after']).toBeDefined()
    expect(hub.subscriberCount()).toBe(1)
  })
})
