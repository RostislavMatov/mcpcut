import { describe, expect, test } from 'vitest'
import { waitUntil } from '../../proxy/harness.js'
import {
  createSessionManager,
  type ResponsePlan,
  type SessionContext,
  type SessionManagerOptions,
} from '../../../src/transport/http/session.js'
import {
  createFakeRes,
  createFakeSessionFactory,
  testDetectInitialize,
  testExpectsResponse,
  INITIALIZE_BODY,
  NO_RESPONSE_MARKER,
  type FakeFactoryOptions,
  type FakeSessionFactory,
} from './front-harness.js'

/**
 * Unit tests for the dual-model session manager (M3 Task 10), driven
 * directly (no HTTP server) with the fake echo session factory. The
 * decisions documented in `session.ts` are pinned here: one in-flight
 * request per session (parallel → 409), response = the session's next
 * message, buffered server-initiated messages with an oldest-drop cap,
 * GET replacement, TTL eviction sparing sessions with an open stream.
 */

const CTX: SessionContext = { agentName: 'bot', serverName: 'github' }
const REQUEST_BODY = '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
const NOTIFICATION_BODY = `{"jsonrpc":"2.0","method":"notifications/x","${NO_RESPONSE_MARKER}":1}`

interface Managed {
  readonly manager: ReturnType<typeof createSessionManager>
  readonly factory: FakeSessionFactory
}

function createManager(
  overrides: Partial<SessionManagerOptions> = {},
  factoryOptions: FakeFactoryOptions = {},
): Managed {
  const factory = createFakeSessionFactory(factoryOptions)
  const manager = createSessionManager({
    openSession: factory.openSession,
    detectInitialize: testDetectInitialize,
    expectsResponse: testExpectsResponse,
    ...overrides,
  })
  return { manager, factory }
}

function bodyText(plan: ResponsePlan): string {
  return plan.body?.toString('utf8') ?? ''
}

async function openSessionfulSession(managed: Managed): Promise<string> {
  const plan = await managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))
  expect(plan.status).toBe(200)
  const id = plan.headers?.['mcp-session-id']
  expect(typeof id).toBe('string')
  return id as string
}

describe('sessionful model', () => {
  test('initialize opens a session and answers with Mcp-Session-Id + the session response', async () => {
    const managed = createManager({ uuid: () => 'fixed-session-id' })

    const plan = await managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))

    expect(plan.status).toBe(200)
    expect(plan.headers?.['mcp-session-id']).toBe('fixed-session-id')
    expect(bodyText(plan)).toBe(INITIALIZE_BODY)
    expect(managed.manager.activeSessionCount()).toBe(1)
    expect(managed.factory.handles).toHaveLength(1)
  })

  test('a follow-up POST with the session id reaches the SAME session', async () => {
    const managed = createManager()
    const id = await openSessionfulSession(managed)

    const plan = await managed.manager.handlePost(
      CTX,
      { 'mcp-session-id': id },
      Buffer.from(REQUEST_BODY),
    )

    expect(plan.status).toBe(200)
    expect(bodyText(plan)).toBe(REQUEST_BODY)
    expect(managed.factory.handles).toHaveLength(1)
    expect(managed.factory.handles[0]?.written).toHaveLength(2)
  })

  test('an unknown session id answers 404 (spec §1.5)', async () => {
    const managed = createManager()
    await openSessionfulSession(managed)

    const plan = await managed.manager.handlePost(
      CTX,
      { 'mcp-session-id': 'never-issued' },
      Buffer.from(REQUEST_BODY),
    )

    expect(plan.status).toBe(404)
    expect(bodyText(plan)).toBe('{"error":"session-not-found"}')
  })

  test("another (agent, server) pair cannot use the session id — isolation answers 404", async () => {
    const managed = createManager()
    const id = await openSessionfulSession(managed)

    const otherAgent = await managed.manager.handlePost(
      { agentName: 'other', serverName: 'github' },
      { 'mcp-session-id': id },
      Buffer.from(REQUEST_BODY),
    )
    const otherServer = await managed.manager.handlePost(
      { agentName: 'bot', serverName: 'jira' },
      { 'mcp-session-id': id },
      Buffer.from(REQUEST_BODY),
    )

    expect(otherAgent.status).toBe(404)
    expect(otherServer.status).toBe(404)
  })

  test('a notification (no response expected) answers 202 without a body', async () => {
    const managed = createManager()
    const id = await openSessionfulSession(managed)

    const plan = await managed.manager.handlePost(
      CTX,
      { 'mcp-session-id': id },
      Buffer.from(NOTIFICATION_BODY),
    )

    expect(plan.status).toBe(202)
    expect(plan.body).toBeUndefined()
  })

  test('a second request while one is in flight answers 409 (documented decision)', async () => {
    // The fake replies only when told to: the first request stays in flight.
    const managed = createManager({}, { respond: () => null })
    const initialize = managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))
    await waitUntil(() => managed.factory.handles.length === 1)
    const handle = managed.factory.handles[0]
    if (handle === undefined) throw new Error('no handle')
    handle.push('{"id":1,"result":{}}')
    const initPlan = await initialize
    const id = initPlan.headers?.['mcp-session-id'] as string

    const first = managed.manager.handlePost(CTX, { 'mcp-session-id': id }, Buffer.from(REQUEST_BODY))
    await waitUntil(() => handle.written.length === 2)
    const second = await managed.manager.handlePost(
      CTX,
      { 'mcp-session-id': id },
      Buffer.from(REQUEST_BODY),
    )

    expect(second.status).toBe(409)
    expect(bodyText(second)).toBe('{"error":"request-in-flight"}')

    handle.push('{"id":2,"result":{}}')
    const firstPlan = await first
    expect(firstPlan.status).toBe(200)
    expect(bodyText(firstPlan)).toBe('{"id":2,"result":{}}')
  })

  test('429 once the concurrent session limit is reached', async () => {
    const managed = createManager({ maxSessions: 1 })
    await openSessionfulSession(managed)

    const plan = await managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))

    expect(plan.status).toBe(429)
    expect(bodyText(plan)).toBe('{"error":"too-many-sessions"}')
  })

  test('the upstream ending its source tears the session down', async () => {
    const managed = createManager()
    const id = await openSessionfulSession(managed)
    const handle = managed.factory.handles[0]
    if (handle === undefined) throw new Error('no handle')

    handle.end()
    await waitUntil(() => managed.manager.activeSessionCount() === 0)

    const plan = await managed.manager.handlePost(
      CTX,
      { 'mcp-session-id': id },
      Buffer.from(REQUEST_BODY),
    )
    expect(plan.status).toBe(404)
    expect(handle.isClosed()).toBe(true)
  })
})

describe('stateless model', () => {
  test('a POST without session id and without initialize is served per-request and closed after', async () => {
    const managed = createManager()

    const plan = await managed.manager.handlePost(CTX, {}, Buffer.from(REQUEST_BODY))

    expect(plan.status).toBe(200)
    expect(bodyText(plan)).toBe(REQUEST_BODY)
    expect(managed.manager.activeSessionCount()).toBe(0)
    expect(managed.factory.handles[0]?.isClosed()).toBe(true)
  })

  test('validateStatelessHeaders mismatch answers 400 with the hook-provided body', async () => {
    const errorBody = Buffer.from('{"error":"header-mismatch","code":-32020}')
    const managed = createManager({
      validateStatelessHeaders: (headers) =>
        headers['mcp-method'] === 'tools/list' ? { ok: true } : { ok: false, errorBody },
    })

    const bad = await managed.manager.handlePost(CTX, {}, Buffer.from(REQUEST_BODY))
    const good = await managed.manager.handlePost(
      CTX,
      { 'mcp-method': 'tools/list' },
      Buffer.from(REQUEST_BODY),
    )

    expect(bad.status).toBe(400)
    expect(bodyText(bad)).toBe(errorBody.toString('utf8'))
    expect(good.status).toBe(200)
  })

  test('a stateless notification answers 202 and still closes its one-shot session', async () => {
    const managed = createManager()

    const plan = await managed.manager.handlePost(CTX, {}, Buffer.from(NOTIFICATION_BODY))

    expect(plan.status).toBe(202)
    expect(plan.body).toBeUndefined()
    expect(managed.factory.handles[0]?.isClosed()).toBe(true)
  })

  test('the default hooks are semantics-free: no detectInitialize → everything is stateless', async () => {
    const factory = createFakeSessionFactory()
    const manager = createSessionManager({ openSession: factory.openSession })

    const plan = await manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))

    expect(plan.status).toBe(200)
    expect(manager.activeSessionCount()).toBe(0)
  })
})

describe('openSession refusals', () => {
  test("'unknown-server' maps to 404 not-found", async () => {
    const managed = createManager({}, { refuseWith: 'unknown-server' })

    const plan = await managed.manager.handlePost(CTX, {}, Buffer.from(REQUEST_BODY))

    expect(plan.status).toBe(404)
    expect(bodyText(plan)).toBe('{"error":"not-found"}')
  })

  test('any other refusal maps to 400 naming the refusal code', async () => {
    const managed = createManager({}, { refuseWith: 'model-mismatch' })

    const plan = await managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))

    expect(plan.status).toBe(400)
    expect(bodyText(plan)).toBe('{"error":"model-mismatch"}')
  })
})

describe('DELETE', () => {
  test('DELETE with the session id tears down and answers 204', async () => {
    const managed = createManager()
    const id = await openSessionfulSession(managed)

    const plan = await managed.manager.handleDelete(CTX, { 'mcp-session-id': id })

    expect(plan.status).toBe(204)
    expect(plan.body).toBeUndefined()
    expect(managed.manager.activeSessionCount()).toBe(0)
    await waitUntil(() => managed.factory.handles[0]?.isClosed() === true)
  })

  test('DELETE without a session id answers 400', async () => {
    const managed = createManager()

    const plan = await managed.manager.handleDelete(CTX, {})

    expect(plan.status).toBe(400)
  })

  test('DELETE with an unknown session id answers 404', async () => {
    const managed = createManager()

    const plan = await managed.manager.handleDelete(CTX, { 'mcp-session-id': 'nope' })

    expect(plan.status).toBe(404)
  })

  test('a request in flight when its session is DELETEd answers 404', async () => {
    const managed = createManager({}, { respond: () => null })
    const initialize = managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))
    await waitUntil(() => managed.factory.handles.length === 1)
    const handle = managed.factory.handles[0]
    if (handle === undefined) throw new Error('no handle')
    handle.push('{"id":1,"result":{}}')
    const id = (await initialize).headers?.['mcp-session-id'] as string

    const pending = managed.manager.handlePost(
      CTX,
      { 'mcp-session-id': id },
      Buffer.from(REQUEST_BODY),
    )
    await waitUntil(() => handle.written.length === 2)
    await managed.manager.handleDelete(CTX, { 'mcp-session-id': id })

    const plan = await pending
    expect(plan.status).toBe(404)
  })
})

describe('GET stream routing', () => {
  test('GET without a session id answers 405 (no stream offered)', () => {
    const managed = createManager()
    const fake = createFakeRes()

    const outcome = managed.manager.handleGet(CTX, {}, fake.res)

    expect(outcome).not.toBe('attached')
    if (outcome !== 'attached') {
      expect(outcome.status).toBe(405)
    }
  })

  test('GET with an unknown session id answers 404', () => {
    const managed = createManager()
    const fake = createFakeRes()

    const outcome = managed.manager.handleGet(CTX, { 'mcp-session-id': 'nope' }, fake.res)

    expect(outcome).not.toBe('attached')
    if (outcome !== 'attached') {
      expect(outcome.status).toBe(404)
    }
  })

  test('server-initiated messages buffered before GET are flushed on attach, later ones stream live', async () => {
    const managed = createManager()
    const id = await openSessionfulSession(managed)
    const handle = managed.factory.handles[0]
    if (handle === undefined) throw new Error('no handle')

    handle.push('{"method":"first"}')
    const fake = createFakeRes()
    const outcome = managed.manager.handleGet(CTX, { 'mcp-session-id': id }, fake.res)
    expect(outcome).toBe('attached')
    handle.push('{"method":"second"}')

    expect(fake.writtenText()).toContain('data: {"method":"first"}\n\n')
    expect(fake.writtenText()).toContain('data: {"method":"second"}\n\n')
  })

  test('the buffer drops the OLDEST message past the cap (documented decision)', async () => {
    const managed = createManager({ maxBufferedMessages: 2 })
    const id = await openSessionfulSession(managed)
    const handle = managed.factory.handles[0]
    if (handle === undefined) throw new Error('no handle')

    handle.push('one')
    handle.push('two')
    handle.push('three')
    const fake = createFakeRes()
    managed.manager.handleGet(CTX, { 'mcp-session-id': id }, fake.res)

    expect(fake.writtenText()).not.toContain('data: one')
    expect(fake.writtenText()).toContain('data: two')
    expect(fake.writtenText()).toContain('data: three')
  })

  test('a message arriving while a POST is in flight is its response, never streamed', async () => {
    const managed = createManager({}, { respond: () => null })
    const initialize = managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))
    await waitUntil(() => managed.factory.handles.length === 1)
    const handle = managed.factory.handles[0]
    if (handle === undefined) throw new Error('no handle')
    handle.push('{"id":1,"result":{}}')
    const id = (await initialize).headers?.['mcp-session-id'] as string

    const fake = createFakeRes()
    managed.manager.handleGet(CTX, { 'mcp-session-id': id }, fake.res)
    const pending = managed.manager.handlePost(
      CTX,
      { 'mcp-session-id': id },
      Buffer.from(REQUEST_BODY),
    )
    await waitUntil(() => handle.written.length === 2)
    handle.push('{"id":2,"result":"answer"}')

    const plan = await pending
    expect(bodyText(plan)).toBe('{"id":2,"result":"answer"}')
    expect(fake.writtenText()).not.toContain('answer')
  })

  test('a second GET replaces the first stream (old response is ended)', async () => {
    const managed = createManager()
    const id = await openSessionfulSession(managed)

    const first = createFakeRes()
    managed.manager.handleGet(CTX, { 'mcp-session-id': id }, first.res)
    const second = createFakeRes()
    const outcome = managed.manager.handleGet(CTX, { 'mcp-session-id': id }, second.res)

    expect(outcome).toBe('attached')
    expect(first.isEnded()).toBe(true)
    managed.factory.handles[0]?.push('later')
    expect(second.writtenText()).toContain('data: later')
    expect(first.writtenText()).not.toContain('data: later')
  })
})

describe('TTL eviction', () => {
  test('an idle session is evicted after the TTL; one with an open GET stream is spared', async () => {
    let nowMs = 1_000_000
    const managed = createManager({
      now: () => nowMs,
      idleTtlMs: 100,
      sweepIntervalMs: 10,
    })
    const idleId = await openSessionfulSession(managed)
    const streamingId = await openSessionfulSession(managed)
    const fake = createFakeRes()
    managed.manager.handleGet(CTX, { 'mcp-session-id': streamingId }, fake.res)

    nowMs += 500
    await waitUntil(() => managed.manager.activeSessionCount() === 1)

    const idlePlan = await managed.manager.handlePost(
      CTX,
      { 'mcp-session-id': idleId },
      Buffer.from(REQUEST_BODY),
    )
    expect(idlePlan.status).toBe(404)
    const streamingPlan = await managed.manager.handlePost(
      CTX,
      { 'mcp-session-id': streamingId },
      Buffer.from(REQUEST_BODY),
    )
    expect(streamingPlan.status).toBe(200)
    await managed.manager.close()
  })
})

describe('manager close', () => {
  test('close tears down every session (upstream closed, streams ended)', async () => {
    const managed = createManager()
    await openSessionfulSession(managed)
    const id = await openSessionfulSession(managed)
    const fake = createFakeRes()
    managed.manager.handleGet(CTX, { 'mcp-session-id': id }, fake.res)

    await managed.manager.close()

    expect(managed.manager.activeSessionCount()).toBe(0)
    expect(managed.factory.handles.every((handle) => handle.isClosed())).toBe(true)
    expect(fake.isEnded()).toBe(true)
  })
})
