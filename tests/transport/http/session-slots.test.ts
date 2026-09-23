import { describe, expect, test } from 'vitest'
import {
  createSessionManager,
  type SessionContext,
  type SessionManagerOptions,
} from '../../../src/transport/http/session.js'
import {
  createFakeSessionFactory,
  testDetectInitialize,
  testExpectsResponse,
  INITIALIZE_BODY,
  type FakeSessionFactory,
} from './front-harness.js'

/**
 * Sessions this manager did not open but which share its budget (plan
 * decision P5).
 *
 * A pool session is one session to this manager and N upstreams to the
 * process: each child costs a spawned server or an open HTTP client exactly
 * like a per-server session does. Without this hook one agent with broad
 * grants would walk straight past `maxSessions`, and the cap would only ever
 * have bounded the sessions that were cheapest to hold.
 */

const CTX: SessionContext = { agentName: 'bot', serverName: 'github' }

interface Managed {
  readonly manager: ReturnType<typeof createSessionManager>
  readonly factory: FakeSessionFactory
}

function createManager(overrides: Partial<SessionManagerOptions> = {}): Managed {
  const factory = createFakeSessionFactory()
  const manager = createSessionManager({
    openSession: factory.openSession,
    detectInitialize: testDetectInitialize,
    expectsResponse: testExpectsResponse,
    ...overrides,
  })
  return { manager, factory }
}

describe('extraSessions', () => {
  test('refuses the very first open when the extra count already fills the cap', async () => {
    // Arrange — the pool's children have taken every slot in the process.
    const managed = createManager({ maxSessions: 2, extraSessions: () => 2 })

    // Act
    const plan = await managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))

    // Assert
    expect(plan.status).toBe(429)
    expect(plan.body?.toString('utf8')).toContain('too-many-sessions')
    await managed.manager.close()
  })

  test('leaves room for exactly the slots the extras do not hold', async () => {
    let children = 0
    const managed = createManager({ maxSessions: 3, extraSessions: () => children })

    const first = await managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))
    expect(first.status).toBe(200)

    // The session just opened spawns two children of its own.
    children = 2
    const second = await managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))

    expect(second.status).toBe(429)
    await managed.manager.close()
  })

  test('behaves exactly as before when nothing extra is declared', async () => {
    // The regression gate: every per-server front in the product passes no
    // `extraSessions`, and their ceiling must not move by one.
    const managed = createManager({ maxSessions: 1 })

    const first = await managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))
    const second = await managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    await managed.manager.close()
  })

  test('counts the extras in the reported active session count', async () => {
    // `activeSessionCount()` is what an operator reads to understand the
    // ceiling; reporting a number the cap does not use would be a lie.
    const managed = createManager({ maxSessions: 8, extraSessions: () => 3 })

    await managed.manager.handlePost(CTX, {}, Buffer.from(INITIALIZE_BODY))

    expect(managed.manager.activeSessionCount()).toBe(4)
    await managed.manager.close()
  })
})
