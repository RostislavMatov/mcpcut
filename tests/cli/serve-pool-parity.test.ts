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
 * The PRD's central claim about the pool, stated as a test: an aggregated
 * address changes WHERE an agent connects and nothing about what the plane
 * decides or records.
 *
 * So the same call is made twice — once through `/agents/:a/servers/:s`, once
 * through `/mcp` with a `<server>__<tool>` name — and the two decision records
 * are compared field by field. What may differ is only what identifies the
 * conversation (`id`, `ts`, `sessionId`, `durationMs`). Everything an auditor
 * reads — the tool name, the outcome, the rule, the provenance hashes — must
 * be identical, or the pool has quietly become a second enforcement path.
 *
 * `toolName` is the sharpest of these: it must be the BARE name in both (PE11).
 * The prefix is a pool-side address, not something policy, quarantine,
 * approvals or the journal were ever told about.
 */

afterEach(async () => {
  await disposeServeFixtures()
})

const SERVER = 'alpha'
const TOOL = 'echo'

/** Fields that identify one conversation rather than one decision. */
const PER_SESSION_FIELDS: readonly string[] = ['id', 'ts', 'sessionId', 'durationMs']

/** The decision a `kind:'decision'` record carries (its own field, not the payload). */
function decisionOf(record: JournalRecord): Record<string, unknown> {
  return (record as unknown as { decision: Record<string, unknown> }).decision
}

function decisionShapeOf(record: JournalRecord): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(record as unknown as Record<string, unknown>) }
  for (const field of PER_SESSION_FIELDS) {
    delete copy[field]
  }
  return copy
}

/**
 * Waits for `count` decision records about `tool` and returns them. Counted by
 * TOOL, not in total: a pooled session also decides its own `tools/list`, so
 * "two decisions" would be reached before either call was made.
 */
async function decisionsForTool(
  fixture: ServeFixture,
  tool: string,
  count: number,
): Promise<JournalRecord[]> {
  const matching = async (): Promise<JournalRecord[]> => {
    const records = await fixture.journalRecords()
    return records.filter(
      (record) => record.kind === 'decision' && decisionOf(record)['toolName'] === tool,
    )
  }
  await waitUntil(async () => (await matching()).length >= count, `${count} decisions for ${tool}`)
  return matching()
}

describe('a call through the pool decides and records exactly as a per-server call does', () => {
  test('the two decision records differ only in which session they belong to', async () => {
    // Arrange — one serve, one agent, one server, reachable both ways.
    const fixture = await startServe({ grant: '*', grantServer: SERVER })
    await fixture.registry.addServer({
      name: SERVER,
      transport: 'stdio',
      command: process.execPath,
      args: [POOL_SERVER, TOOL],
      env: { POOL_FIXTURE_NAME: SERVER },
    })

    // Act (a) — the per-server address, with the bare tool name.
    const perServerPath = `/agents/${AGENT}/servers/${SERVER}`
    const opened = await fixture.post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {} },
      }),
      {},
      perServerPath,
    )
    const perServerSession = opened.headers.get('mcp-session-id') as string
    // Listed first, exactly as the pool leg does and as every MCP client
    // does. Not decoration: the first `tools/list` against a server is what
    // puts its catalog in the inventory, and a tool nobody has ever seen
    // listed is classified fail-closed. Skipping it on one leg only would
    // make this a test about WHO listed first, not about which address was
    // used.
    await fixture.post(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      { 'mcp-session-id': perServerSession },
      perServerPath,
    )
    await fixture.post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: TOOL, arguments: { text: 'hi' } },
      }),
      { 'mcp-session-id': perServerSession },
      perServerPath,
    )

    // Act (b) — the pool address, with the prefixed name.
    const poolOpened = await fixture.post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {} },
      }),
      {},
      POOL_ROUTE_PATH,
    )
    const poolSession = poolOpened.headers.get('mcp-session-id') as string
    await fixture.post(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      { 'mcp-session-id': poolSession },
      POOL_ROUTE_PATH,
    )
    await fixture.post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: `${SERVER}__${TOOL}`, arguments: { text: 'hi' } },
      }),
      { 'mcp-session-id': poolSession },
      POOL_ROUTE_PATH,
    )

    // Assert
    const calls = await decisionsForTool(fixture, TOOL, 2)

    expect(calls).toHaveLength(2)
    // Two sessions run concurrently, so the order is not fixed; the SHAPES are.
    const [first, second] = calls.map(decisionShapeOf)
    expect(first).toEqual(second)
  })

  test('the tool name the plane recorded is the bare one on both paths (PE11)', async () => {
    const fixture = await startServe({ grant: '*', grantServer: SERVER })
    await fixture.registry.addServer({
      name: SERVER,
      transport: 'stdio',
      command: process.execPath,
      args: [POOL_SERVER, TOOL],
      env: { POOL_FIXTURE_NAME: SERVER },
    })

    const poolOpened = await fixture.post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {} },
      }),
      {},
      POOL_ROUTE_PATH,
    )
    const poolSession = poolOpened.headers.get('mcp-session-id') as string
    await fixture.post(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      { 'mcp-session-id': poolSession },
      POOL_ROUTE_PATH,
    )
    await fixture.post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: `${SERVER}__${TOOL}`, arguments: {} },
      }),
      { 'mcp-session-id': poolSession },
      POOL_ROUTE_PATH,
    )

    const [decision] = await decisionsForTool(fixture, TOOL, 1)
    // Not `alpha__echo` anywhere: the prefix is an address the pool strips
    // before any enforcement module sees the frame.
    expect(decisionOf(decision as JournalRecord)['toolName']).toBe(TOOL)
    expect(JSON.stringify(decision)).not.toContain(`${SERVER}__`)
  })

  test('the provenance hashes match, so no second read of the grant matrix crept in', async () => {
    // If these ever differ, the pool has started deriving an agent's authority
    // somewhere other than the one reader on the traffic path.
    const fixture = await startServe({ grant: '*', grantServer: SERVER })
    await fixture.registry.addServer({
      name: SERVER,
      transport: 'stdio',
      command: process.execPath,
      args: [POOL_SERVER, TOOL],
      env: { POOL_FIXTURE_NAME: SERVER },
    })

    const perServerPath = `/agents/${AGENT}/servers/${SERVER}`
    const opened = await fixture.post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {} },
      }),
      {},
      perServerPath,
    )
    await fixture.post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: TOOL, arguments: {} },
      }),
      { 'mcp-session-id': opened.headers.get('mcp-session-id') as string },
      perServerPath,
    )

    const poolOpened = await fixture.post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {} },
      }),
      {},
      POOL_ROUTE_PATH,
    )
    const poolSession = poolOpened.headers.get('mcp-session-id') as string
    await fixture.post(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      { 'mcp-session-id': poolSession },
      POOL_ROUTE_PATH,
    )
    await fixture.post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: `${SERVER}__${TOOL}`, arguments: {} },
      }),
      { 'mcp-session-id': poolSession },
      POOL_ROUTE_PATH,
    )

    const calls = await decisionsForTool(fixture, TOOL, 2)
    const hashes = calls.map((record) => {
      const decision = decisionOf(record)
      return { policyHash: decision['policyHash'], grantsHash: decision['grantsHash'] }
    })
    expect(hashes[0]).toEqual(hashes[1])
    expect(hashes[0]?.grantsHash).toBeTruthy()
  })
})
