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
 * DR1: the departure a withdrawn grant leaves in the journal is ALWAYS
 * `ungranted`, whichever of the two watches notices first.
 *
 * Two watches race on an ungrant: the pool's own (which detaches the server as
 * `ungranted`) and the one inside every child session (which ends that session
 * as `revoked`). Before DR1 the second one won about a third of the time and
 * the pool wrote `child-ended`. Each ordering is forced here by setting the two
 * poll intervals far apart.
 */

afterEach(async () => {
  await disposeServeFixtures()
})

const POOL = POOL_ROUTE_PATH
const FAST_POLL_MS = 25
const NEVER_POLL_MS = 60_000

async function register(fixture: ServeFixture, name: string): Promise<void> {
  await fixture.registry.addServer({
    name,
    transport: 'stdio',
    command: process.execPath,
    args: [POOL_SERVER, 'echo'],
    env: { POOL_FIXTURE_NAME: name },
  })
  await fixture.agents.grantServer(AGENT, name, '*')
}

async function openPoolAndList(fixture: ServeFixture): Promise<void> {
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
  expect(opened.status).toBe(200)
  const sessionId = opened.headers.get('mcp-session-id') as string
  const listed = await fixture.post(
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    { 'mcp-session-id': sessionId },
    POOL,
  )
  expect(listed.status).toBe(200)
  await listed.text()
}

function detachesOf(records: readonly JournalRecord[], server: string): unknown[] {
  return records
    .filter((record) => record.kind === 'pool')
    .map((record) => record.payload as { event?: string; serverName?: string })
    .filter((payload) => payload.event === 'detach' && payload.serverName === server)
}

async function ungrantAndReadDeparture(fixture: ServeFixture): Promise<unknown[]> {
  await fixture.agents.ungrantServer(AGENT, 'beta')
  await waitUntil(
    async () => detachesOf(await fixture.journalRecords(), 'beta').length > 0,
    'the departure of beta',
  )
  // Let the slower watch have its say too: it must not add a second record.
  await new Promise((resolve) => setTimeout(resolve, 200))
  return detachesOf(await fixture.journalRecords(), 'beta')
}

describe('the departure a withdrawn grant leaves (DR1)', () => {
  test('is `ungranted` when the child session’s own watch notices first', async () => {
    // Arrange
    const fixture = await startServe({
      serveOptions: { revocationPollIntervalMs: FAST_POLL_MS, poolWatchPollIntervalMs: NEVER_POLL_MS },
    })
    await register(fixture, 'alpha')
    await register(fixture, 'beta')
    await openPoolAndList(fixture)

    // Act
    const departures = await ungrantAndReadDeparture(fixture)

    // Assert
    expect(departures).toEqual([expect.objectContaining({ reason: 'ungranted' })])
  })

  test('is `ungranted` when the pool’s watch notices first', async () => {
    // Arrange
    const fixture = await startServe({
      serveOptions: { revocationPollIntervalMs: NEVER_POLL_MS, poolWatchPollIntervalMs: FAST_POLL_MS },
    })
    await register(fixture, 'alpha')
    await register(fixture, 'beta')
    await openPoolAndList(fixture)

    // Act
    const departures = await ungrantAndReadDeparture(fixture)

    // Assert
    expect(departures).toEqual([expect.objectContaining({ reason: 'ungranted' })])
  })
})
