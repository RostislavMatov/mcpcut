import { afterEach, describe, expect, test } from 'vitest'
import { disposeServeFixtures, waitUntil } from './serve-harness.js'
import {
  attachesOf,
  isAlive,
  listNames,
  openPool,
  pidsOf,
  poolPayloads,
  registerResident,
  startResidentServe,
  waitForDeath,
  waitForStarts,
} from './serve-residents-harness.js'

/**
 * Residents on a live `serve` (ADR-0016, RS1-RS5): a stdio server granted to
 * an agent is running BEFORE the agent connects, is reused across its
 * connections, and is never handed to anybody else.
 */

afterEach(async () => {
  await disposeServeFixtures()
})

describe('a granted stdio server', () => {
  test('is running before the agent ever connects', async () => {
    // Arrange / Act
    const fixture = await startResidentServe()
    await registerResident(fixture, 'memory')

    // Assert
    const [pid] = await waitForStarts(fixture, 'memory', 1)
    expect(isAlive(pid as number)).toBe(true)
    await waitUntil(() => fixture.io.errText().includes('[serve] resident research-bot/memory: ready'), 'ready line')
  })

  test('answers the first tools/list with no new start, as a resident', async () => {
    // Arrange
    const fixture = await startResidentServe()
    await registerResident(fixture, 'memory')
    await waitUntil(() => fixture.io.errText().includes('resident research-bot/memory: ready'), 'ready')

    // Act
    const pool = await openPool(fixture)
    const names = await listNames(pool)

    // Assert
    expect(names).toEqual(['memory__echo'])
    expect(await pidsOf(fixture, 'memory')).toHaveLength(1)
    const [attach] = await attachesOf(fixture, 1)
    expect(attach).toMatchObject({ serverName: 'memory', lifetime: 'resident' })
  })

  test('is the same process — and the same session — on the next connection', async () => {
    // Arrange
    const fixture = await startResidentServe()
    await registerResident(fixture, 'memory')
    await waitUntil(() => fixture.io.errText().includes('resident research-bot/memory: ready'), 'ready')
    const first = await openPool(fixture)
    await listNames(first)
    await first.close()

    // Act
    const second = await openPool(fixture)
    const names = await listNames(second)

    // Assert
    expect(names).toEqual(['memory__echo'])
    expect(await pidsOf(fixture, 'memory')).toHaveLength(1)
    const attaches = await attachesOf(fixture, 2)
    expect(attaches[0]?.['childSessionId']).toBe(attaches[1]?.['childSessionId'])
  })

  test('another agent granted the same server gets a process of its own (RS3)', async () => {
    // Arrange
    const fixture = await startResidentServe()
    const other = await fixture.agents.createAgent('other-bot')
    await registerResident(fixture, 'memory')
    await fixture.agents.grantServer('other-bot', 'memory', '*')

    // Act
    const pids = await waitForStarts(fixture, 'memory', 2)
    const mine = await openPool(fixture)
    const theirs = await openPool(fixture, other.token)
    await listNames(mine)
    await listNames(theirs)

    // Assert
    expect(new Set(pids).size).toBe(2)
    const attaches = await attachesOf(fixture, 2)
    expect(new Set(attaches.map((attach) => attach['childSessionId'])).size).toBe(2)
    expect(await pidsOf(fixture, 'memory')).toHaveLength(2)
  })
})

describe('two pool sessions of one agent at once', () => {
  test('the second gets a process of its own, which goes with it', async () => {
    // Arrange
    const fixture = await startResidentServe()
    await registerResident(fixture, 'memory')
    await waitForStarts(fixture, 'memory', 1)
    const first = await openPool(fixture)
    await listNames(first)

    // Act
    const second = await openPool(fixture)
    await listNames(second)
    const [, extra] = await waitForStarts(fixture, 'memory', 2)
    await second.close()

    // Assert
    const attaches = await attachesOf(fixture, 2)
    expect(attaches.map((attach) => attach['lifetime'])).toEqual(['resident', 'pool'])
    await waitForDeath(extra as number)
    expect(isAlive((await pidsOf(fixture, 'memory'))[0] as number)).toBe(true)
  })
})

describe('a pool that closes with a call in flight (RS5)', () => {
  test('leaves the held session dirty: a fresh process serves the next connection', async () => {
    // Arrange
    const fixture = await startResidentServe()
    await registerResident(fixture, 'memory', { tools: ['slow_echo'], env: { POOL_FIXTURE_DELAY_MS: '600' } })
    const [firstPid] = await waitForStarts(fixture, 'memory', 1)
    const first = await openPool(fixture)
    await listNames(first)
    const inFlight = first.call({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'memory__slow_echo', arguments: {} } })

    // Act
    await new Promise((resolve) => setTimeout(resolve, 100))
    await first.close()
    await inFlight.catch(() => undefined)

    // Assert
    await waitUntil(
      async () => poolPayloads(await fixture.journalRecords(), 'detach').some((detach) => detach['reason'] === 'in-flight-at-close'),
      'the in-flight-at-close record',
    )
    await waitForDeath(firstPid as number)
    const [, secondPid] = await waitForStarts(fixture, 'memory', 2)
    const second = await openPool(fixture)
    expect(await listNames(second)).toEqual(['memory__slow_echo'])
    // The SAME id again, with a marker the old call never carried: the answer
    // is this call's own, never a late reply to the pool that left.
    const again = await second.call({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'memory__slow_echo', arguments: { mark: 'new' } },
    })
    expect(JSON.stringify(again)).toContain('new')
    expect(isAlive(secondPid as number)).toBe(true)
  })
})
