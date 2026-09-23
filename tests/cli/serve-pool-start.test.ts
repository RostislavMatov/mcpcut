import { afterEach, describe, expect, test } from 'vitest'
import type { JournalRecord } from '../../src/journal/record.js'
import { POOL_ROUTE_PATH } from '../../src/transport/http/server-constants.js'
import {
  AGENT,
  disposeServeFixtures,
  POOL_SERVER,
  startServe,
  waitUntil,
  type ServeFixture,
} from './serve-harness.js'

/**
 * D1: how long a pool waits for a server to come up (BU1-BU3), against a live
 * `serve` and real spawned processes.
 *
 * The start budget is its OWN number, separate from the list budget that
 * follows it; a server that dies during its start is refused at once rather
 * than at the deadline; and the refusal says which of the three happened.
 */

afterEach(async () => {
  await disposeServeFixtures()
})

const POOL = POOL_ROUTE_PATH

interface Registration {
  readonly name: string
  readonly args?: readonly string[]
  readonly command?: string
  readonly env?: Record<string, string>
}

async function register(fixture: ServeFixture, entry: Registration): Promise<void> {
  await fixture.registry.addServer({
    name: entry.name,
    transport: 'stdio',
    command: entry.command ?? process.execPath,
    args: [...(entry.args ?? [POOL_SERVER, 'echo'])],
    env: { POOL_FIXTURE_NAME: entry.name, ...entry.env },
  })
  await fixture.agents.grantServer(AGENT, entry.name, '*')
}

/** Opens a pool and times its first `tools/list`. */
async function firstList(fixture: ServeFixture): Promise<{ names: string[]; elapsedMs: number }> {
  const opened = await fixture.post(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {} },
    }),
    {},
    POOL,
  )
  const sessionId = opened.headers.get('mcp-session-id') as string
  const started = Date.now()
  const listed = await fixture.post(
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    { 'mcp-session-id': sessionId },
    POOL,
  )
  const body = (await listed.json()) as { result?: { tools?: { name: string }[] } }
  return {
    names: (body.result?.tools ?? []).map((tool) => tool.name),
    elapsedMs: Date.now() - started,
  }
}

function refusalsOf(records: readonly JournalRecord[]): unknown[] {
  return records
    .filter((record) => record.kind === 'pool')
    .map((record) => record.payload as { event?: string })
    .filter((payload) => payload.event === 'attach-refused')
}

describe('the start budget of a pooled server (BU1)', () => {
  test('is its own number: a server slower than the LIST budget still joins', async () => {
    // Arrange
    const fixture = await startServe({
      serveOptions: { poolStartTimeoutMs: 3000, poolFanoutTimeoutMs: 500 },
    })
    await register(fixture, { name: 'slow', env: { POOL_FIXTURE_START_DELAY_MS: '1500' } })

    // Act
    const listed = await firstList(fixture)

    // Assert
    expect(listed.names).toEqual(['slow__echo'])
  })

  test('a server past it is refused as `start-timeout`, and the others do not wait longer', async () => {
    // Arrange
    const fixture = await startServe({ serveOptions: { poolStartTimeoutMs: 1000 } })
    await register(fixture, { name: 'late', env: { POOL_FIXTURE_START_DELAY_MS: '3000' } })
    await register(fixture, { name: 'quick', args: [POOL_SERVER, 'query'] })

    // Act
    const listed = await firstList(fixture)

    // Assert
    expect(listed.names).toEqual(['quick__query'])
    expect(listed.elapsedMs).toBeLessThan(2500)
    await waitUntil(
      async () => refusalsOf(await fixture.journalRecords()).length > 0,
      'the refusal of late',
    )
    expect(refusalsOf(await fixture.journalRecords())).toEqual([
      expect.objectContaining({ serverName: 'late', reason: 'start-timeout' }),
    ])
    expect(fixture.io.errText()).toContain('server late did not start within 1 s')
  })

  test('servers start at once: two slow ones cost the slowest, not the sum', async () => {
    // Arrange — different command lines: identical ones never start in
    // parallel once the supervisor runs stdio starts (BU4).
    const fixture = await startServe({ serveOptions: { poolStartTimeoutMs: 5000 } })
    await register(fixture, { name: 'one', args: [POOL_SERVER, 'echo'], env: { POOL_FIXTURE_START_DELAY_MS: '1000' } })
    await register(fixture, { name: 'two', args: [POOL_SERVER, 'query'], env: { POOL_FIXTURE_START_DELAY_MS: '1000' } })

    // Act
    const listed = await firstList(fixture)

    // Assert
    expect(listed.names).toEqual(['one__echo', 'two__query'])
    expect(listed.elapsedMs).toBeLessThan(2000)
  })
})

describe('a server that dies during its start (BU2, BU3)', () => {
  test('is refused as `ended-during-start` long before the deadline', async () => {
    // Arrange
    const budgetMs = 10_000
    const fixture = await startServe({ serveOptions: { poolStartTimeoutMs: budgetMs } })
    await register(fixture, { name: 'broken', args: ['-e', 'process.exit(3)'] })
    await register(fixture, { name: 'fine' })

    // Act
    const listed = await firstList(fixture)

    // Assert
    expect(listed.names).toEqual(['fine__echo'])
    expect(listed.elapsedMs).toBeLessThan(budgetMs / 2)
    await waitUntil(
      async () => refusalsOf(await fixture.journalRecords()).length > 0,
      'the refusal of broken',
    )
    expect(refusalsOf(await fixture.journalRecords())).toEqual([
      expect.objectContaining({ serverName: 'broken', reason: 'ended-during-start' }),
    ])
    expect(fixture.io.errText()).toContain('server broken ended before it started')
  })
})
