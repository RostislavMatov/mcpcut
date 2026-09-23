import { describe, expect, test } from 'vitest'
import { waitUntil } from '../../proxy/harness.js'
import {
  createSessionManager,
  type ResponsePlan,
  type SessionContext,
  type SessionManagerOptions,
} from '../../../src/transport/http/session.js'
import type { ResponseCorrelation } from '../../../src/transport/http/session-support.js'
import {
  createFakeSessionFactory,
  testDetectInitialize,
  testExpectsResponse,
  INITIALIZE_BODY,
  type FakeFactoryOptions,
  type FakeSessionFactory,
} from './front-harness.js'

/**
 * Opt-in response correlation (plan decision P1).
 *
 * Without it the front pairs replies POSITIONALLY — "the answer is the next
 * message this session emits" — which allows exactly one POST in flight. A
 * pool session cannot live with that: `connect --url` writes POSTs without
 * waiting for the previous answer (`src/bridge/pump.ts`), and one
 * `tools/call` held by a human approval would then 409 every other call the
 * agent makes. A session that declares `correlate` may hold several.
 *
 * Every test here also has a silent partner: the per-server path, which
 * declares nothing and must keep behaving exactly as it did.
 */

const CTX: SessionContext = { agentName: 'bot', serverName: '_pool' }

/** Correlates on the JSON-RPC `id`, which is what the real pool hook does. */
const BY_ID: ResponseCorrelation = {
  keyOfRequest: (bytes) => idKeyOf(bytes),
  keyOfResponse: (bytes) => idKeyOf(bytes),
}

function idKeyOf(bytes: Buffer): string | null {
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null) return null
  const id = (parsed as Record<string, unknown>)['id']
  return typeof id === 'string' || typeof id === 'number' ? `${typeof id}:${id}` : null
}

function request(id: number | string): Buffer {
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call' }), 'utf8')
}

function reply(id: number | string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result: { ok: id } })
}

interface Managed {
  readonly manager: ReturnType<typeof createSessionManager>
  readonly factory: FakeSessionFactory
}

function createManager(
  overrides: Partial<SessionManagerOptions> = {},
  factoryOptions: FakeFactoryOptions = {},
): Managed {
  // `respond: () => null` — replies are pushed by hand, so their ORDER is
  // under the test's control rather than the sink's.
  const factory = createFakeSessionFactory({ respond: () => null, ...factoryOptions })
  const manager = createSessionManager({
    openSession: factory.openSession,
    detectInitialize: testDetectInitialize,
    expectsResponse: testExpectsResponse,
    ...overrides,
  })
  return { manager, factory }
}

async function openCorrelatingSession(managed: Managed): Promise<string> {
  // The handshake itself is one exchange: reply to it as the upstream would.
  const pending = managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))
  await waitUntil(() => managed.factory.handles.length === 1)
  managed.factory.handles[0]?.push(reply(1))
  const plan = await pending
  expect(plan.status).toBe(200)
  return plan.headers?.['mcp-session-id'] as string
}

function withSession(id: string): Record<string, string> {
  return { 'mcp-session-id': id }
}

function bodyText(plan: ResponsePlan): string {
  return plan.body?.toString('utf8') ?? ''
}

describe('a session that declares correlation', () => {
  test('answers three in-flight requests each with its OWN reply', async () => {
    // Arrange
    const managed = createManager({}, { correlate: BY_ID })
    const sid = await openCorrelatingSession(managed)
    const control = managed.factory.handles[0]

    // Act — three POSTs in flight at once, answered in reverse order.
    const first = managed.manager.handlePost(CTX, withSession(sid), request(10))
    const second = managed.manager.handlePost(CTX, withSession(sid), request(11))
    const third = managed.manager.handlePost(CTX, withSession(sid), request(12))
    await waitUntil(() => (control?.written.length ?? 0) === 4)
    control?.push(reply(12))
    control?.push(reply(11))
    control?.push(reply(10))

    // Assert
    expect(bodyText(await first)).toContain('"ok":10')
    expect(bodyText(await second)).toContain('"ok":11')
    expect(bodyText(await third)).toContain('"ok":12')
    await managed.manager.close()
  })

  test('sends a reply nobody is waiting on to the GET stream instead of losing it', async () => {
    // A server-initiated message (or a late reply) still follows the old
    // cascade: open stream first, bounded buffer otherwise.
    const managed = createManager({}, { correlate: BY_ID })
    const sid = await openCorrelatingSession(managed)

    managed.factory.handles[0]?.push(reply(999))

    // Nothing was waiting on id 999, so it must have been buffered for the
    // stream rather than handed to some other request.
    const pending = managed.manager.handlePost(CTX, withSession(sid), request(10))
    await waitUntil(() => (managed.factory.handles[0]?.written.length ?? 0) === 2)
    managed.factory.handles[0]?.push(reply(10))
    expect(bodyText(await pending)).toContain('"ok":10')
    await managed.manager.close()
  })

  test('refuses a second POST carrying an id already in flight', async () => {
    // A duplicate id is the CLIENT's mistake, not the session being busy:
    // two live requests under one id is "one outcome per id" broken.
    const managed = createManager({}, { correlate: BY_ID })
    const sid = await openCorrelatingSession(managed)

    const first = managed.manager.handlePost(CTX, withSession(sid), request(10))
    const second = await managed.manager.handlePost(CTX, withSession(sid), request(10))

    expect(second.status).toBe(409)
    expect(bodyText(second)).toContain('request-in-flight')
    managed.factory.handles[0]?.push(reply(10))
    await first
    await managed.manager.close()
  })

  test('refuses past the in-flight ceiling with 429, not 409', async () => {
    const managed = createManager({ maxCorrelatedInFlight: 2 }, { correlate: BY_ID })
    const sid = await openCorrelatingSession(managed)

    const held = [
      managed.manager.handlePost(CTX, withSession(sid), request(1)),
      managed.manager.handlePost(CTX, withSession(sid), request(2)),
    ]
    const overflow = await managed.manager.handlePost(CTX, withSession(sid), request(3))

    expect(overflow.status).toBe(429)
    expect(bodyText(overflow)).toContain('too-many-requests-in-flight')
    managed.factory.handles[0]?.push(reply(1))
    managed.factory.handles[0]?.push(reply(2))
    await Promise.all(held)
    await managed.manager.close()
  })

  test('answers 202 to a notification without occupying a slot', async () => {
    const managed = createManager({ maxCorrelatedInFlight: 1 }, { correlate: BY_ID })
    const sid = await openCorrelatingSession(managed)

    // A notification is owed no answer, so the key is null and nothing is
    // registered — otherwise one notification would block the whole session.
    const notification = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/x' }))
    const plan = await managed.manager.handlePost(CTX, withSession(sid), notification)
    expect(plan.status).toBe(202)

    const pending = managed.manager.handlePost(CTX, withSession(sid), request(10))
    await waitUntil(() => (managed.factory.handles[0]?.written.length ?? 0) === 3)
    managed.factory.handles[0]?.push(reply(10))
    expect((await pending).status).toBe(200)
    await managed.manager.close()
  })

  test('treats an unreadable body as owed no answer rather than throwing', async () => {
    // Fail closed the way `expectsResponse` does: a hook that throws on
    // garbage must not take the request handler down.
    const throwing: ResponseCorrelation = {
      keyOfRequest: () => {
        throw new Error('unreadable')
      },
      keyOfResponse: () => null,
    }
    const managed = createManager({}, { correlate: throwing })
    const sid = await openCorrelatingSession(managed)

    const plan = await managed.manager.handlePost(CTX, withSession(sid), request(10))

    expect(plan.status).toBe(202)
    await managed.manager.close()
  })

  test('answers every waiting request 404 when the session is torn down', async () => {
    const managed = createManager({}, { correlate: BY_ID })
    const sid = await openCorrelatingSession(managed)

    const waiting = [
      managed.manager.handlePost(CTX, withSession(sid), request(1)),
      managed.manager.handlePost(CTX, withSession(sid), request(2)),
      managed.manager.handlePost(CTX, withSession(sid), request(3)),
    ]
    await waitUntil(() => (managed.factory.handles[0]?.written.length ?? 0) === 4)
    await managed.manager.handleDelete(CTX, withSession(sid))

    for (const plan of await Promise.all(waiting)) {
      expect(plan.status).toBe(404)
      expect(bodyText(plan)).toContain('session-not-found')
    }
    await managed.manager.close()
  })

  test('keeps the session alive while a slow request waits', async () => {
    // `lastActivityMs` has to move when a request is REGISTERED, not only
    // when it is answered: a pool call held by an approval, on a session
    // with no GET stream, would otherwise be swept mid-wait.
    let clock = 1_000
    const managed = createManager(
      { correlate: undefined, idleTtlMs: 50, sweepIntervalMs: 5, now: () => clock },
      { correlate: BY_ID },
    )
    const sid = await openCorrelatingSession(managed)

    const pending = managed.manager.handlePost(CTX, withSession(sid), request(10))
    await waitUntil(() => (managed.factory.handles[0]?.written.length ?? 0) === 2)
    clock += 40
    await new Promise((resolve) => setTimeout(resolve, 20))
    managed.factory.handles[0]?.push(reply(10))

    expect((await pending).status).toBe(200)
    await managed.manager.close()
  })
})

describe('a session that declares nothing', () => {
  test('still refuses a second parallel POST with 409', async () => {
    // The regression gate for every per-server address in the product.
    const managed = createManager()
    const openPlan = managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))
    await waitUntil(() => managed.factory.handles.length === 1)
    managed.factory.handles[0]?.push(reply(1))
    const sid = (await openPlan).headers?.['mcp-session-id'] as string

    const first = managed.manager.handlePost(CTX, withSession(sid), request(10))
    const second = await managed.manager.handlePost(CTX, withSession(sid), request(11))

    expect(second.status).toBe(409)
    // And the positional pairing still holds: the NEXT message answers the
    // first request, whatever id it carries.
    managed.factory.handles[0]?.push(reply(77))
    expect(bodyText(await first)).toContain('"ok":77')
    await managed.manager.close()
  })
})
