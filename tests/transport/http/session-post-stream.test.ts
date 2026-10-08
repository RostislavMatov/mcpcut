import { afterEach, describe, expect, test, vi } from 'vitest'
import { waitUntil } from '../../proxy/harness.js'
import {
  createSessionManager,
  type ProgressCorrelation,
  type ResponsePlan,
  type SessionContext,
  type SessionManagerOptions,
} from '../../../src/transport/http/session.js'
import type { ResponseCorrelation } from '../../../src/transport/http/session-support.js'
import { STREAMED, startPostStream } from '../../../src/transport/http/session-post-stream.js'
import { openSseStream } from '../../../src/transport/http/sse.js'
import {
  createFakeRes,
  createFakeSessionFactory,
  testDetectInitialize,
  testExpectsResponse,
  INITIALIZE_BODY,
  type FakeRes,
  type FakeSessionFactory,
} from './front-harness.js'

/**
 * Decision M36, phase B, at the HTTP front: a POST whose call is held for a
 * human becomes an SSE stream — the call's progress as events, its answer as
 * the last one — so Claude Code's 60-second cut on a JSON answer never fires;
 * a POST that closes before its answer abandons the request (a held call is
 * withdrawn); and a session waiting on a request is never swept as idle.
 */

const CTX: SessionContext = { agentName: 'bot', serverName: 'srv' }
const POOL_CTX: SessionContext = { agentName: 'bot', serverName: '_pool' }

function parsedObject(bytes: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function tokenKey(token: unknown): string | null {
  return typeof token === 'string' || typeof token === 'number' ? `${typeof token}:${token}` : null
}

/** The real hook's shape: a request by its `_meta.progressToken`, a progress notification by `params.progressToken`. */
const BY_TOKEN: ProgressCorrelation = {
  keyOfRequest: (bytes) => {
    const params = parsedObject(bytes)?.['params'] as Record<string, unknown> | undefined
    return tokenKey((params?.['_meta'] as Record<string, unknown> | undefined)?.['progressToken'])
  },
  keyOfNotification: (bytes) => {
    const message = parsedObject(bytes)
    if (message?.['method'] !== 'notifications/progress') return null
    return tokenKey((message['params'] as Record<string, unknown> | undefined)?.['progressToken'])
  },
}

const BY_ID: ResponseCorrelation = {
  keyOfRequest: (bytes) => (parsedObject(bytes)?.['method'] === undefined ? null : tokenKey(parsedObject(bytes)?.['id'])),
  keyOfResponse: (bytes) => (parsedObject(bytes)?.['method'] !== undefined ? null : tokenKey(parsedObject(bytes)?.['id'])),
}

function call(id: number, token?: string): Buffer {
  const meta = token === undefined ? {} : { _meta: { progressToken: token } }
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'x', ...meta } }))
}

function progress(token: string, n: number): string {
  return JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: n } })
}

function reply(id: number): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result: { ok: id } })
}

interface Managed {
  readonly manager: ReturnType<typeof createSessionManager>
  readonly factory: FakeSessionFactory
}

const managers: Managed[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(managers.splice(0).map((managed) => managed.manager.close()))
})

function createManager(overrides: Partial<SessionManagerOptions> = {}, correlate?: ResponseCorrelation): Managed {
  const factory = createFakeSessionFactory({ respond: () => null, ...(correlate !== undefined ? { correlate } : {}) })
  const manager = createSessionManager({
    openSession: factory.openSession,
    detectInitialize: testDetectInitialize,
    expectsResponse: testExpectsResponse,
    progress: BY_TOKEN,
    ...overrides,
  })
  const managed = { manager, factory }
  managers.push(managed)
  return managed
}

async function openSession(managed: Managed, ctx: SessionContext = CTX): Promise<string> {
  const pending = managed.manager.handlePost(ctx, {}, Buffer.from(INITIALIZE_BODY))
  await waitUntil(() => managed.factory.handles.length === 1)
  managed.factory.handles[0]?.push(reply(1))
  const plan = (await pending) as ResponsePlan
  return plan.headers?.['mcp-session-id'] as string
}

/** A POST whose response the test can read as an SSE stream, the way the front opens one. */
function streamingPost(): { readonly fake: FakeRes; readonly signal: AbortSignal; abort(): void; openStream(): ReturnType<typeof openSseStream> } {
  const fake = createFakeRes()
  const controller = new AbortController()
  return {
    fake,
    signal: controller.signal,
    abort: () => controller.abort(),
    openStream: () => openSseStream(fake.res, { heartbeatIntervalMs: 60_000 }),
  }
}

function events(fake: FakeRes): unknown[] {
  return fake
    .writtenText()
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice('data: '.length)) as unknown)
}

describe('a POST becomes an SSE stream when its call is held', () => {
  test('progress on the request opens the stream; the answer is the last event and ends it', async () => {
    const managed = createManager()
    const sid = await openSession(managed)
    const control = managed.factory.handles[0]!
    const post = streamingPost()

    const outcome = managed.manager.handlePost(CTX, { 'mcp-session-id': sid }, call(7, 'tok'), post)
    await waitUntil(() => control.written.length === 2)
    control.push(progress('tok', 1))
    control.push(progress('tok', 2))
    expect(post.fake.isEnded()).toBe(false)
    control.push(reply(7))

    expect(await outcome).toBe(STREAMED)
    expect(events(post.fake)).toEqual([
      JSON.parse(progress('tok', 1)),
      JSON.parse(progress('tok', 2)),
      JSON.parse(reply(7)),
    ])
    expect(post.fake.isEnded()).toBe(true)
  })

  test('the same on a correlating (pool) session, each POST hearing only its own progress', async () => {
    const managed = createManager({}, BY_ID)
    const sid = await openSession(managed, POOL_CTX)
    const control = managed.factory.handles[0]!
    const first = streamingPost()
    const second = streamingPost()

    const one = managed.manager.handlePost(POOL_CTX, { 'mcp-session-id': sid }, call(10, 'a'), first)
    const two = managed.manager.handlePost(POOL_CTX, { 'mcp-session-id': sid }, call(11, 'b'), second)
    await waitUntil(() => control.written.length === 3)
    control.push(progress('b', 1))
    control.push(progress('a', 1))
    control.push(reply(11))
    control.push(reply(10))

    expect(await one).toBe(STREAMED)
    expect(await two).toBe(STREAMED)
    expect(events(first.fake)).toEqual([JSON.parse(progress('a', 1)), JSON.parse(reply(10))])
    expect(events(second.fake)).toEqual([JSON.parse(progress('b', 1)), JSON.parse(reply(11))])
  })

  test('a quick answer stays plain JSON', async () => {
    const managed = createManager()
    const sid = await openSession(managed)
    const post = streamingPost()

    const outcome = managed.manager.handlePost(CTX, { 'mcp-session-id': sid }, call(8, 'tok'), post)
    await waitUntil(() => managed.factory.handles[0]!.written.length === 2)
    managed.factory.handles[0]!.push(reply(8))

    const plan = (await outcome) as ResponsePlan
    expect(plan.status).toBe(200)
    expect(plan.body?.toString('utf8')).toBe(reply(8))
    expect(post.fake.writtenText()).toBe('')
  })

  test('with no answer by the deadline the stream opens anyway, token or not', async () => {
    const managed = createManager({ postStreamAfterMs: 5 })
    const sid = await openSession(managed)
    const post = streamingPost()

    const outcome = managed.manager.handlePost(CTX, { 'mcp-session-id': sid }, call(9), post)
    await waitUntil(() => managed.factory.handles[0]!.written.length === 2)
    await new Promise((resolve) => setTimeout(resolve, 30))
    managed.factory.handles[0]!.push(reply(9))

    expect(await outcome).toBe(STREAMED)
    expect(events(post.fake)).toEqual([JSON.parse(reply(9))])
  })

  test('a client that does not take SSE keeps JSON, and progress is never read as its answer', async () => {
    const managed = createManager()
    const sid = await openSession(managed)
    const control = managed.factory.handles[0]!

    const outcome = managed.manager.handlePost(CTX, { 'mcp-session-id': sid }, call(12, 'tok'))
    await waitUntil(() => control.written.length === 2)
    control.push(progress('tok', 1))
    control.push(reply(12))

    const plan = (await outcome) as ResponsePlan
    expect(plan.body?.toString('utf8')).toBe(reply(12))
  })
})

describe('the agent abandons a POST before its answer (M36 phase B, review R1)', () => {
  test('on a correlating session the request is reported abandoned and its late answer dropped', async () => {
    const managed = createManager({}, BY_ID)
    const sid = await openSession(managed, POOL_CTX)
    const control = managed.factory.handles[0]!
    const post = streamingPost()

    const outcome = managed.manager.handlePost(POOL_CTX, { 'mcp-session-id': sid }, call(20, 'tok'), post)
    await waitUntil(() => control.written.length === 2)
    control.push(progress('tok', 1))
    post.abort()

    expect(await outcome).toBe(STREAMED)
    expect(control.abandoned.map((bytes) => bytes.toString('utf8'))).toEqual([call(20, 'tok').toString('utf8')])

    // A late answer goes nowhere: not to a GET stream opened later, not to another POST.
    control.push(reply(20))
    const get = createFakeRes()
    expect(managed.manager.handleGet(POOL_CTX, { 'mcp-session-id': sid }, get.res)).toBe('attached')
    expect(get.writtenText()).toBe('')
  })

  test('on a positional session the session ends: its held work is withdrawn by the teardown', async () => {
    const managed = createManager()
    const sid = await openSession(managed)
    const control = managed.factory.handles[0]!
    const post = streamingPost()

    const outcome = managed.manager.handlePost(CTX, { 'mcp-session-id': sid }, call(21, 'tok'), post)
    await waitUntil(() => control.written.length === 2)
    post.abort()
    await outcome

    await waitUntil(() => control.isClosed())
    const next = (await managed.manager.handlePost(CTX, { 'mcp-session-id': sid }, call(22))) as ResponsePlan
    expect(next.status).toBe(404)
  })

  test('a POST that already had its answer abandons nothing', async () => {
    const managed = createManager({}, BY_ID)
    const sid = await openSession(managed, POOL_CTX)
    const control = managed.factory.handles[0]!
    const post = streamingPost()

    const outcome = managed.manager.handlePost(POOL_CTX, { 'mcp-session-id': sid }, call(23), post)
    await waitUntil(() => control.written.length === 2)
    control.push(reply(23))
    await outcome
    post.abort()

    expect(control.abandoned).toEqual([])
  })
})

describe('the idle sweeper never ends a session that waits on a request', () => {
  test('a held POST outlives the idle TTL; the session goes once it is answered and idle again', async () => {
    let nowMs = 1_000_000
    const managed = createManager({ now: () => nowMs, idleTtlMs: 1_000, sweepIntervalMs: 5 }, BY_ID)
    const sid = await openSession(managed, POOL_CTX)
    const control = managed.factory.handles[0]!

    const outcome = managed.manager.handlePost(POOL_CTX, { 'mcp-session-id': sid }, call(30))
    await waitUntil(() => control.written.length === 2)
    nowMs += 60_000
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(control.isClosed()).toBe(false)

    control.push(reply(30))
    await outcome
    nowMs += 60_000
    await waitUntil(() => control.isClosed())
  })
})

describe('startPostStream', () => {
  test('cannot stream without an opener; finish and abort then leave the answer to JSON', () => {
    const stream = startPostStream({ open: undefined, upgradeAfterMs: 1 })

    expect(stream.send(Buffer.from('x'))).toBe(false)
    expect(stream.finish(Buffer.from('y'))).toBeNull()
    expect(stream.abort()).toBeNull()
  })

  test('nothing is sent after it finished, and the deadline no longer opens it', async () => {
    const post = streamingPost()
    const stream = startPostStream({ open: post.openStream, upgradeAfterMs: 5 })

    expect(stream.finish(Buffer.from('{"a":1}'))).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(stream.send(Buffer.from('{"b":2}'))).toBe(false)
    expect(post.fake.writtenText()).toBe('')
  })
})
