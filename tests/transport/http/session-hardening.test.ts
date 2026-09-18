import { describe, expect, test } from 'vitest'
import { waitUntil } from '../../proxy/harness.js'
import {
  createSessionManager,
  type OpenSession,
  type OpenedSession,
  type ResponsePlan,
  type SessionContext,
  type SessionManager,
  type SessionManagerOptions,
} from '../../../src/transport/http/session.js'
import {
  createFakeRes,
  createFakeSessionFactory,
  testDetectInitialize,
  testExpectsResponse,
  INITIALIZE_BODY,
  type FakeSessionFactory,
} from './front-harness.js'

/**
 * Hardening tests for the dual-model session manager: the paths a hung,
 * dead or abandoned upstream takes (nothing may wait forever), the
 * concurrency cap under parallel opens (no TOCTOU window, stateless
 * counted), the bounded server-initiated buffer in BYTES, refusal bodies
 * that must stay code-only, and the diagnostics contract.
 */

const CTX: SessionContext = { agentName: 'bot', serverName: 'github' }
const REQUEST_BODY = '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

function bodyText(plan: ResponsePlan): string {
  return plan.body?.toString('utf8') ?? ''
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface Managed {
  readonly manager: SessionManager
  readonly factory: FakeSessionFactory
}

/** A manager over the standard fake factory, with the standard test hooks. */
function createManaged(
  overrides: Partial<SessionManagerOptions> = {},
  factory: FakeSessionFactory = createFakeSessionFactory({ respond: () => null }),
): Managed {
  const manager = createSessionManager({
    openSession: factory.openSession,
    detectInitialize: testDetectInitialize,
    expectsResponse: testExpectsResponse,
    ...overrides,
  })
  return { manager, factory }
}

// ---------------------------------------------------------------------------
// A stateless POST must never wait forever
// ---------------------------------------------------------------------------

describe('stateless POST: bounded waiting', () => {
  test('an upstream that ends without answering answers 404 and closes the one-shot session', async () => {
    const managed = createManaged()

    const pending = managed.manager.handlePost(CTX, {}, Buffer.from(REQUEST_BODY))
    await waitUntil(() => managed.factory.handles.length === 1)
    const handle = managed.factory.handles[0]
    if (handle === undefined) throw new Error('no handle')
    handle.end()

    const plan = await pending
    expect(plan.status).toBe(404)
    expect(bodyText(plan)).toBe('{"error":"session-not-found"}')
    expect(handle.isClosed()).toBe(true)
    expect(managed.manager.activeSessionCount()).toBe(0)
  })

  test('a silent upstream answers 504 once the timeout elapses, and the session is closed', async () => {
    const managed = createManaged({ statelessTimeoutMs: 10 })

    const plan = await managed.manager.handlePost(CTX, {}, Buffer.from(REQUEST_BODY))

    expect(plan.status).toBe(504)
    expect(bodyText(plan)).toBe('{"error":"upstream-timeout"}')
    expect(managed.factory.handles[0]?.isClosed()).toBe(true)
    expect(managed.manager.activeSessionCount()).toBe(0)
  })

  test('a client that goes away mid-request releases the upstream immediately', async () => {
    const managed = createManaged({ statelessTimeoutMs: 60_000 })
    const controller = new AbortController()

    const pending = managed.manager.handlePost(CTX, {}, Buffer.from(REQUEST_BODY), {
      signal: controller.signal,
    })
    await waitUntil(() => managed.factory.handles.length === 1)
    controller.abort()

    const plan = await pending
    expect(plan.status).toBe(504)
    expect(managed.factory.handles[0]?.isClosed()).toBe(true)
  })

  test('a source error surfaces as a failure (500 branch) and still closes the upstream', async () => {
    // A transport error is the plane's own problem, not an answer the agent
    // can act on: it keeps the detail-free 500 path. What must NOT happen is
    // the upstream staying open behind it.
    const managed = createManaged({ statelessTimeoutMs: 60_000 })

    const pending = managed.manager.handlePost(CTX, {}, Buffer.from(REQUEST_BODY))
    await waitUntil(() => managed.factory.handles.length === 1)
    managed.factory.handles[0]?.fail(new Error('upstream socket died'))

    await expect(pending).rejects.toThrow('upstream socket died')
    expect(managed.factory.handles[0]?.isClosed()).toBe(true)
    expect(managed.manager.activeSessionCount()).toBe(0)
  })

  test('manager close terminates an in-flight stateless request instead of leaking it', async () => {
    const managed = createManaged({ statelessTimeoutMs: 60_000 })

    const pending = managed.manager.handlePost(CTX, {}, Buffer.from(REQUEST_BODY))
    await waitUntil(() => managed.factory.handles.length === 1)
    await managed.manager.close()

    expect((await pending).status).toBe(404)
    expect(managed.factory.handles[0]?.isClosed()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The concurrency cap
// ---------------------------------------------------------------------------

describe('maxSessions is a real cap', () => {
  /** Wraps a factory so every open takes a turn of the event loop. */
  function slowFactory(factory: FakeSessionFactory): OpenSession {
    return async (ctx) => {
      await sleep(5)
      return factory.openSession(ctx)
    }
  }

  test('parallel initialize requests cannot exceed the cap (the check never straddles an await)', async () => {
    const factory = createFakeSessionFactory()
    const manager = createSessionManager({
      openSession: slowFactory(factory),
      detectInitialize: testDetectInitialize,
      expectsResponse: testExpectsResponse,
      maxSessions: 2,
    })

    const plans = await Promise.all(
      Array.from({ length: 5 }, () => manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))),
    )

    expect(plans.filter((plan) => plan.status === 200)).toHaveLength(2)
    expect(plans.filter((plan) => plan.status === 429)).toHaveLength(3)
    expect(factory.handles).toHaveLength(2)
    expect(manager.activeSessionCount()).toBe(2)
    await manager.close()
  })

  test('a stateless request in flight occupies a slot and is counted', async () => {
    const managed = createManaged({ maxSessions: 1, statelessTimeoutMs: 60_000 })

    const pending = managed.manager.handlePost(CTX, {}, Buffer.from(REQUEST_BODY))
    await waitUntil(() => managed.factory.handles.length === 1)

    expect(managed.manager.activeSessionCount()).toBe(1)
    const refused = await managed.manager.handlePost(CTX, {}, Buffer.from(REQUEST_BODY))
    expect(refused.status).toBe(429)
    expect(bodyText(refused)).toBe('{"error":"too-many-sessions"}')
    expect(managed.factory.handles).toHaveLength(1)

    await managed.manager.close()
    await pending
    expect(managed.manager.activeSessionCount()).toBe(0)
  })

  test('a refused open frees its slot again', async () => {
    const factory = createFakeSessionFactory({ refuseWith: 'no-grant' })
    const manager = createSessionManager({
      openSession: factory.openSession,
      detectInitialize: testDetectInitialize,
      expectsResponse: testExpectsResponse,
      maxSessions: 1,
    })

    expect((await manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))).status).toBe(403)
    expect((await manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))).status).toBe(403)
    expect(manager.activeSessionCount()).toBe(0)
    await manager.close()
  })

  /**
   * An authenticated agent asking for a server it was not granted is refused
   * for WHO it is, not for what it sent — the definition of 403 (user-journey
   * smoke 2026-09-18, UX-11). It answered 400 only because "anything that is
   * not `unknown-server`" was the catch-all; ADR-0002 pins 400 for the
   * session-model mismatch, which IS about the request, and that one stays.
   */
  test('a no-grant refusal is 403, while a malformed-request refusal stays 400', async () => {
    const noGrant = createSessionManager({
      openSession: createFakeSessionFactory({ refuseWith: 'no-grant' }).openSession,
      detectInitialize: testDetectInitialize,
      expectsResponse: testExpectsResponse,
    })
    const mismatch = createSessionManager({
      openSession: createFakeSessionFactory({ refuseWith: 'protocol-mismatch: ...' }).openSession,
      detectInitialize: testDetectInitialize,
      expectsResponse: testExpectsResponse,
    })

    const refusedGrant = await noGrant.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))
    const refusedShape = await mismatch.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))

    expect(refusedGrant.status).toBe(403)
    expect(bodyText(refusedGrant)).toBe('{"error":"no-grant"}')
    expect(refusedShape.status).toBe(400)
    expect(bodyText(refusedShape)).toBe('{"error":"protocol-mismatch"}')
    await noGrant.close()
    await mismatch.close()
  })

  test('the cap is applied before any semantic hook runs, so a refused POST leaves no model note', async () => {
    let detectCalls = 0
    const managed = createManaged({
      maxSessions: 0,
      detectInitialize: (bytes: Buffer) => {
        detectCalls += 1
        return testDetectInitialize(bytes)
      },
    })

    const plan = await managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))

    expect(plan.status).toBe(429)
    expect(detectCalls).toBe(0)
    expect(managed.factory.handles).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Abandoned opens (a POST that consulted the hooks but opens nothing)
// ---------------------------------------------------------------------------

describe('onOpenAbandoned', () => {
  test('fires when stateless header validation refuses the request', async () => {
    let abandoned = 0
    const managed = createManaged({
      validateStatelessHeaders: () => ({ ok: false, errorBody: Buffer.from('{"error":"x"}') }),
      onOpenAbandoned: () => {
        abandoned += 1
      },
    })

    const plan = await managed.manager.handlePost(CTX, {}, Buffer.from(REQUEST_BODY))

    expect(plan.status).toBe(400)
    expect(abandoned).toBe(1)
    expect(managed.factory.handles).toHaveLength(0)
  })

  test('does NOT fire when a session is actually opened', async () => {
    let abandoned = 0
    const managed = createManaged(
      {
        onOpenAbandoned: () => {
          abandoned += 1
        },
      },
      createFakeSessionFactory(),
    )

    await managed.manager.handlePost(CTX, {}, Buffer.from(REQUEST_BODY))

    expect(abandoned).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The server-initiated buffer is bounded in bytes, not only in count
// ---------------------------------------------------------------------------

describe('buffered server-initiated messages', () => {
  test('the byte budget evicts the oldest messages, newest kept', async () => {
    const managed = createManaged({ maxBufferedBytes: 10 }, createFakeSessionFactory())
    const plan = await managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))
    const id = plan.headers?.['mcp-session-id'] as string
    const handle = managed.factory.handles[0]
    if (handle === undefined) throw new Error('no handle')

    handle.push('aaaaaa')
    handle.push('bbbbbb')
    const fake = createFakeRes()
    managed.manager.handleGet(CTX, { 'mcp-session-id': id }, fake.res)

    expect(fake.writtenText()).not.toContain('aaaaaa')
    expect(fake.writtenText()).toContain('bbbbbb')
    await managed.manager.close()
  })

  test('a message larger than the whole budget is dropped, and does not evict later ones', async () => {
    const managed = createManaged({ maxBufferedBytes: 8 }, createFakeSessionFactory())
    const plan = await managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))
    const id = plan.headers?.['mcp-session-id'] as string
    const handle = managed.factory.handles[0]
    if (handle === undefined) throw new Error('no handle')

    handle.push('x'.repeat(64))
    handle.push('small')
    const fake = createFakeRes()
    managed.manager.handleGet(CTX, { 'mcp-session-id': id }, fake.res)

    expect(fake.writtenText()).not.toContain('xxxx')
    expect(fake.writtenText()).toContain('small')
    await managed.manager.close()
  })
})

// ---------------------------------------------------------------------------
// Refusal bodies carry a code, never prose about the plane's registry
// ---------------------------------------------------------------------------

describe('refusal bodies', () => {
  test('an explanatory refusal reaches the agent as its bare code', async () => {
    const managed = createManaged(
      {},
      createFakeSessionFactory({
        refuseWith:
          'protocol-mismatch: the agent opened a stateless MCP session but server "github" is ' +
          'registered as a sessionful HTTP server; see docs/adr/0002-http-dual-version.md',
      }),
    )

    const plan = await managed.manager.handlePost(CTX, {}, Buffer.from(REQUEST_BODY))

    expect(plan.status).toBe(400)
    expect(bodyText(plan)).toBe('{"error":"protocol-mismatch"}')
    expect(bodyText(plan)).not.toContain('registered as')
    expect(bodyText(plan)).not.toContain('docs/adr')
  })

  test('a refusal that is not code-shaped degrades to the generic bad-request body', async () => {
    const managed = createManaged({}, createFakeSessionFactory({ refuseWith: 'Something Broke!' }))

    const plan = await managed.manager.handlePost(CTX, {}, Buffer.from(REQUEST_BODY))

    expect(plan.status).toBe(400)
    expect(bodyText(plan)).toBe('{"error":"bad-request"}')
  })
})

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

describe('onSessionError', () => {
  test('receives the error object, not just the session id', async () => {
    const factory = createFakeSessionFactory()
    const seen: Array<{ sessionId: string; error: unknown }> = []
    const failing: OpenSession = async (ctx) => {
      const opened = await factory.openSession(ctx)
      if ('error' in opened) return opened
      const wrapped: OpenedSession = {
        sink: opened.sink,
        source: opened.source,
        close: () => Promise.reject(new Error('close-failed')),
      }
      return wrapped
    }
    const manager = createSessionManager({
      openSession: failing,
      detectInitialize: testDetectInitialize,
      expectsResponse: testExpectsResponse,
      onSessionError: (sessionId, error) => seen.push({ sessionId, error }),
    })
    const plan = await manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))
    const id = plan.headers?.['mcp-session-id'] as string

    await manager.handleDelete(CTX, { 'mcp-session-id': id })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.sessionId).toBe(id)
    expect(seen[0]?.error).toBeInstanceOf(Error)
    expect((seen[0]?.error as Error).message).toBe('close-failed')
  })
})
