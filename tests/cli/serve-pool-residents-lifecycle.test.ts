import { afterEach, describe, expect, test } from 'vitest'
import { runServe, type ServeHandle } from '../../src/cli/serve-cmd.js'
import {
  captureIo,
  disposeServeFixtures,
  onDispose,
  POLL_INTERVAL_MS,
  POOL_SERVER,
  waitUntil,
} from './serve-harness.js'
import {
  AGENT,
  isAlive,
  listNames,
  openPool,
  pidFileOf,
  pidLines,
  pidsOf,
  poolPayloads,
  registerResident,
  RESIDENT_SERVE_OPTIONS,
  startResidentServe,
  waitForDeath,
  waitForStarts,
} from './serve-residents-harness.js'

/**
 * The life of a resident (ADR-0016, RS4, RS6, RS10): it stops when its grant
 * goes, comes back when it dies, gives up on a command that cannot start,
 * restarts for an edited record or a rotated secret, and leaves nothing
 * behind when `serve` stops — and comes back when `serve` starts again.
 */

afterEach(async () => {
  await disposeServeFixtures()
})

describe('a withdrawn grant', () => {
  test('stops an idle resident within the poll interval', async () => {
    const fixture = await startResidentServe()
    await registerResident(fixture, 'memory')
    const [pid] = await waitForStarts(fixture, 'memory', 1)

    await fixture.agents.ungrantServer(AGENT, 'memory')

    await waitForDeath(pid as number)
  })

  test('stops an attached one after the pool lets it go, and the departure says `ungranted`', async () => {
    // Arrange
    const fixture = await startResidentServe()
    await registerResident(fixture, 'memory')
    await registerResident(fixture, 'fs', { tools: ['read'] })
    const [pid] = await waitForStarts(fixture, 'memory', 1)
    await waitForStarts(fixture, 'fs', 1)
    const pool = await openPool(fixture)
    await listNames(pool)

    // Act
    await fixture.agents.ungrantServer(AGENT, 'memory')

    // Assert
    await waitForDeath(pid as number)
    await waitUntil(
      async () => poolPayloads(await fixture.journalRecords(), 'detach').length > 0,
      'the departure of memory',
    )
    expect(poolPayloads(await fixture.journalRecords(), 'detach')).toEqual([
      expect.objectContaining({ serverName: 'memory', reason: 'ungranted' }),
    ])
  })

  test('a revoked agent loses every resident it had', async () => {
    const fixture = await startResidentServe()
    await registerResident(fixture, 'memory')
    await registerResident(fixture, 'fs', { tools: ['read'] })
    const [memory] = await waitForStarts(fixture, 'memory', 1)
    const [fs] = await waitForStarts(fixture, 'fs', 1)

    await fixture.agents.revokeAgent(AGENT)

    await waitForDeath(memory as number)
    await waitForDeath(fs as number)
  })
})

describe('a resident that dies (RS6)', () => {
  test('is started again after a pause', async () => {
    const fixture = await startResidentServe()
    await registerResident(fixture, 'memory')
    const [first] = await waitForStarts(fixture, 'memory', 1)

    process.kill(first as number, 'SIGKILL')

    const [, second] = await waitForStarts(fixture, 'memory', 2)
    expect(second).not.toBe(first)
    await waitUntil(() => fixture.io.errText().includes('restarting in'), 'the restart line')
  })

  test('killed while attached: the pool sees it leave, and the next list attaches the new one', async () => {
    // Arrange
    const fixture = await startResidentServe()
    await registerResident(fixture, 'memory')
    const [first] = await waitForStarts(fixture, 'memory', 1)
    const pool = await openPool(fixture)
    await listNames(pool)

    // Act
    process.kill(first as number, 'SIGKILL')
    await waitUntil(
      async () => poolPayloads(await fixture.journalRecords(), 'detach').some((d) => d['reason'] === 'child-ended'),
      'child-ended',
    )
    await waitForStarts(fixture, 'memory', 2)
    await waitUntil(() => (fixture.io.errText().match(/resident research-bot\/memory: ready/g) ?? []).length >= 2, 'ready again')

    // Assert
    expect(await listNames(pool, 3)).toEqual(['memory__echo'])
  })

  test('a command that cannot start is given up on after five failures in a row', async () => {
    const fixture = await startResidentServe()
    await fixture.registry.addServer({ name: 'broken', transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(1)'] })
    await fixture.agents.grantServer(AGENT, 'broken', '*')

    await waitUntil(
      () => fixture.io.errText().includes('resident research-bot/broken: gave up after 5 failures in a row'),
      'the give-up line',
    )
  })
})

describe('a changed server', () => {
  test('an edited record restarts the resident', async () => {
    const fixture = await startResidentServe()
    await registerResident(fixture, 'memory')
    const [first] = await waitForStarts(fixture, 'memory', 1)
    const record = await fixture.registry.getServer('memory')

    await fixture.registry.updateServer({ ...(record as never), args: [POOL_SERVER, 'echo', 'more'] })

    await waitForDeath(first as number)
    await waitForStarts(fixture, 'memory', 2)
  })

  test('a rotated vault secret restarts it at the next attach', async () => {
    // Arrange
    const fixture = await startResidentServe()
    await fixture.vault.setSecret('memory-key', 'first-secret-value')
    await registerResident(fixture, 'memory', { env: { MEMORY_KEY: 'vault:memory-key' } })
    const [first] = await waitForStarts(fixture, 'memory', 1)
    await fixture.vault.setSecret('memory-key', 'second-secret-value')

    // Act
    const pool = await openPool(fixture)
    const names = await listNames(pool)

    // Assert
    expect(names).toEqual(['memory__echo'])
    const pids = await pidsOf(fixture, 'memory')
    expect(pids).toHaveLength(2)
    expect(isAlive(first as number)).toBe(false)
  })
})

describe('serve itself', () => {
  test('leaves no resident behind when it stops', async () => {
    const fixture = await startResidentServe()
    await registerResident(fixture, 'memory')
    await registerResident(fixture, 'fs', { tools: ['read'] })
    const pool = await openPool(fixture)
    await listNames(pool)
    const pids = [...(await pidsOf(fixture, 'memory')), ...(await pidsOf(fixture, 'fs'))]

    await fixture.shutdown()

    expect(pids).toHaveLength(2)
    expect(pids.filter(isAlive)).toEqual([])
  })

  test('brings the residents back when it starts again, one command line at a time', async () => {
    // Arrange: two servers with the SAME command line, each slow to start.
    const fixture = await startResidentServe()
    const slow = { POOL_FIXTURE_START_DELAY_MS: '300' }
    await registerResident(fixture, 'one', { env: slow })
    await fixture.registry.addServer({
      name: 'two',
      transport: 'stdio',
      command: process.execPath,
      args: [POOL_SERVER, 'echo'],
      env: { POOL_FIXTURE_NAME: 'two', POOL_FIXTURE_PID_FILE: pidFileOf(fixture, 'one'), ...slow },
    })
    await fixture.agents.grantServer(AGENT, 'two', '*')
    await waitForStarts(fixture, 'one', 2)
    await fixture.shutdown()

    // Act
    const io = captureIo()
    let handle: ServeHandle | undefined
    const exit = runServe(['--port', '0', '--policy', fixture.policyPath], io, {
      journalDir: fixture.journalDir,
      signals: [],
      revocationPollIntervalMs: POLL_INTERVAL_MS,
      ...RESIDENT_SERVE_OPTIONS,
      onListening: (started) => {
        handle = started
      },
    })
    onDispose(async () => {
      await handle?.shutdown()
      await exit
      for (const line of await pidLines(fixture, 'one')) if (isAlive(line.pid)) process.kill(line.pid, 'SIGKILL')
    })

    // Assert
    const lines = await waitUntil(async () => (await pidLines(fixture, 'one')).length >= 4, 'two restarts').then(() =>
      pidLines(fixture, 'one'),
    )
    const [third, fourth] = lines.slice(2)
    // The second of two identical command lines starts only once the first
    // has come up: never in parallel (BU4).
    expect(Math.abs((fourth?.startedAt ?? 0) - (third?.startedAt ?? 0))).toBeGreaterThanOrEqual(250)
  })
})
