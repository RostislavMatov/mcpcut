import { afterEach, describe, expect, test } from 'vitest'
import { POOL_ROUTE_PATH } from '../../src/transport/http/server-constants.js'
import { disposeServeFixtures, waitUntil } from './serve-harness.js'
import {
  attachesOf,
  isAlive,
  listNames,
  openPool,
  pidsOf,
  registerResident,
  startResidentServe,
  waitForDeath,
  waitForStarts,
} from './serve-residents-harness.js'

/**
 * Past the resident cap, a stdio server starts when its agent asks, and stays
 * warm for a while after the agent leaves (ADR-0016, RS7, RS8). Warm servers
 * are the first to give their slot up when the service runs short.
 */

afterEach(async () => {
  await disposeServeFixtures()
})

describe('a server past the resident cap', () => {
  test('starts on demand, is reused while warm, and goes once the warmth runs out', async () => {
    // Arrange — the cap of 1 keeps `aaa` resident and `bbb` on demand.
    const fixture = await startResidentServe({ maxPoolResidents: 1, poolWarmIdleMs: 600 })
    await registerResident(fixture, 'aaa')
    await registerResident(fixture, 'bbb', { tools: ['query'] })
    await waitForStarts(fixture, 'aaa', 1)
    await waitUntil(() => fixture.io.errText().includes('over the cap of 1'), 'the over-cap line')
    expect(await pidsOf(fixture, 'bbb')).toEqual([])

    // Act — on demand.
    const first = await openPool(fixture)
    expect(await listNames(first)).toEqual(['aaa__echo', 'bbb__query'])
    const [warm] = await pidsOf(fixture, 'bbb')
    await first.close()

    // Act — back before the warmth runs out.
    const second = await openPool(fixture)
    expect(await listNames(second)).toEqual(['aaa__echo', 'bbb__query'])
    await second.close()

    // Assert
    expect(await pidsOf(fixture, 'bbb')).toEqual([warm])
    const lifetimes = (await attachesOf(fixture, 4)).map((attach) => `${String(attach['serverName'])}:${String(attach['lifetime'])}`)
    expect(lifetimes.sort()).toEqual(['aaa:resident', 'aaa:resident', 'bbb:warm', 'bbb:warm'])
    await waitForDeath(warm as number, 'the warm server to expire')
    expect(isAlive((await pidsOf(fixture, 'aaa'))[0] as number)).toBe(true)
  })
})

describe('a service short of slots', () => {
  test('a new session takes an idle warm server’s slot; a resident keeps its own', async () => {
    // Arrange — two slots: one resident, one idle warm server.
    const fixture = await startResidentServe({ maxPoolResidents: 1, maxSessions: 3 })
    await registerResident(fixture, 'aaa')
    await registerResident(fixture, 'bbb', { tools: ['query'] })
    const [resident] = await waitForStarts(fixture, 'aaa', 1)
    const first = await openPool(fixture)
    await listNames(first)
    const [warm] = await pidsOf(fixture, 'bbb')
    await first.close()

    // Act — the pool session itself needs the third slot, and so does one more.
    const second = await openPool(fixture)
    const extra = await fixture.post(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } }),
      {},
      POOL_ROUTE_PATH,
    )

    // Assert
    expect(second.sessionId).toBeTruthy()
    expect(extra.status).toBe(200)
    await waitForDeath(warm as number, 'the warm server to yield its slot')
    expect(isAlive(resident as number)).toBe(true)
  })
})
