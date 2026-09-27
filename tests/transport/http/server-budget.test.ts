import { afterEach, describe, expect, test } from 'vitest'
import { waitUntil } from '../../proxy/harness.js'
import { createRequestBudget } from '../../../src/transport/http/request-budget.js'
import { BODY_RATE_LIMITED } from '../../../src/transport/http/server-constants.js'
import {
  openSseCapture,
  startFront,
  INITIALIZE_BODY,
  type StartedFront,
} from './front-harness.js'

/**
 * The request budget on the agent front (plan `hosted-path-and-ops`, P7):
 * a front handed a budget spends one unit per authenticated request to a
 * real route, BEFORE the body is read, and answers `429` + `Retry-After`
 * once it is spent. A front handed none behaves exactly as before.
 */

const REQUEST_BODY = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

/** 2026-09-27T10:00:00Z. */
const T0 = Date.UTC(2026, 8, 27, 10, 0, 0)

let started: StartedFront | null = null

afterEach(async () => {
  await started?.dispose()
  started = null
})

/** A clock the test moves by hand; the front reads it through `now`. */
function manualClock(): { now: () => number; advance: (ms: number) => void } {
  let current = T0
  return { now: () => current, advance: (ms) => (current += ms) }
}

async function postMany(front: StartedFront, count: number): Promise<number[]> {
  const statuses: number[] = []
  for (let i = 0; i < count; i += 1) {
    const response = await front.call('POST', front.path(), { body: REQUEST_BODY })
    await response.arrayBuffer()
    statuses.push(response.status)
  }
  return statuses
}

describe('front with a request budget (tenant mode)', () => {
  test('a burst of 20 passes; the 21st is 429 with Retry-After and a short body', async () => {
    const clock = manualClock()
    started = await startFront({
      now: clock.now,
      requestBudget: createRequestBudget({ perSecond: 10, perDay: 10_000 }),
    })

    const statuses = await postMany(started, 20)
    const refused = await started.call('POST', started.path(), { body: REQUEST_BODY })

    expect(statuses.every((status) => status === 200)).toBe(true)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('1')
    expect(Buffer.from(await refused.arrayBuffer())).toEqual(BODY_RATE_LIMITED)
  })

  test('a second later the bucket has refilled and requests pass again', async () => {
    const clock = manualClock()
    started = await startFront({
      now: clock.now,
      requestBudget: createRequestBudget({ perSecond: 10, perDay: 10_000 }),
    })
    await postMany(started, 21)

    clock.advance(1_000)

    expect(await postMany(started, 10)).toEqual(Array(10).fill(200))
  })

  test('the day limit refuses past perDay with a Retry-After in hours, not seconds', async () => {
    const clock = manualClock()
    started = await startFront({
      now: clock.now,
      requestBudget: createRequestBudget({ perSecond: 1_000, perDay: 5 }),
    })
    await postMany(started, 5)

    const refused = await started.call('POST', started.path(), { body: REQUEST_BODY })

    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBe(24 * 3_600)
  })

  test('requests with a wrong token are refused 401 and do not spend the budget', async () => {
    const clock = manualClock()
    started = await startFront({
      now: clock.now,
      requestBudget: createRequestBudget({ perSecond: 1, perDay: 10_000 }),
    })

    for (let i = 0; i < 30; i += 1) {
      const response = await started.call('POST', started.path(), {
        body: REQUEST_BODY,
        noAuth: true,
        headers: { authorization: 'Bearer not-a-real-token' },
      })
      await response.arrayBuffer()
      expect(response.status).toBe(401)
    }

    expect(await postMany(started, 2)).toEqual([200, 200])
  })

  test('a valid token on a path that is no route gets 404 and spends nothing', async () => {
    const clock = manualClock()
    started = await startFront({
      now: clock.now,
      requestBudget: createRequestBudget({ perSecond: 1, perDay: 10_000 }),
    })

    for (let i = 0; i < 10; i += 1) {
      const response = await started.call('POST', '/nowhere', { body: REQUEST_BODY })
      await response.arrayBuffer()
      expect(response.status).toBe(404)
    }

    expect(await postMany(started, 2)).toEqual([200, 200])
  })

  test('the GET stream is one request: messages keep flowing on it after the budget is spent', async () => {
    const clock = manualClock()
    started = await startFront({
      now: clock.now,
      requestBudget: createRequestBudget({ perSecond: 1, perDay: 10_000 }),
    })
    const init = await started.call('POST', started.path(), { body: INITIALIZE_BODY })
    const sessionId = init.headers.get('mcp-session-id') as string
    const capture = await openSseCapture(started, started.path(), { 'mcp-session-id': sessionId })
    const handle = started.factory.handles[0]
    if (handle === undefined) throw new Error('no handle')

    const next = await started.call('POST', started.path(), {
      body: REQUEST_BODY,
      headers: { 'mcp-session-id': sessionId },
    })
    for (let i = 0; i < 5; i += 1) handle.push(`{"method":"note-${i}"}`)
    await waitUntil(() => capture.events.length >= 5)

    expect(capture.status).toBe(200)
    expect(next.status).toBe(429)
    expect(capture.events).toEqual([0, 1, 2, 3, 4].map((i) => `{"method":"note-${i}"}`))
    capture.close()
  })
})

describe('front without a request budget (not a tenant install)', () => {
  test('a burst far past any tenant limit is never refused 429', async () => {
    started = await startFront()

    const statuses = await postMany(started, 40)

    expect(statuses.every((status) => status === 200)).toBe(true)
  })
})
