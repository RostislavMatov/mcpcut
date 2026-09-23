import { afterEach, describe, expect, test } from 'vitest'
import type { JournalRecord } from '../../src/journal/record.js'
import { POOL_ROUTE_PATH } from '../../src/transport/http/server-constants.js'
import {
  AGENT,
  disposeServeFixtures,
  HTTP_STATELESS_FIXTURE,
  POOL_MODERN_SERVER,
  POOL_SERVER,
  startHttpFixture,
  startServe,
  waitUntil,
  type ServeFixture,
} from './serve-harness.js'

/**
 * D4: members of BOTH protocol revisions in one pool (ADR-0015 amendment
 * 2026-09-23, RV1-RV5), against a live `serve` and real upstreams: a stdio
 * server that speaks only 2026-07-28, a dual-mode one, and an HTTP server that
 * refuses the handshake the way the TS SDK v2's `legacy: 'reject'` does.
 */

afterEach(async () => {
  await disposeServeFixtures()
})

const POOL = POOL_ROUTE_PATH
const PROTOCOL_KEY = 'io.modelcontextprotocol/protocolVersion'

async function grant(fixture: ServeFixture, name: string): Promise<void> {
  await fixture.agents.grantServer(AGENT, name, '*')
}

async function registerStdio(
  fixture: ServeFixture,
  name: string,
  file: string,
  tools: readonly string[],
  env: Record<string, string> = {},
): Promise<void> {
  await fixture.registry.addServer({
    name,
    transport: 'stdio',
    command: process.execPath,
    args: [file, ...tools],
    env: { POOL_FIXTURE_NAME: name, ...env },
  })
  await grant(fixture, name)
}

async function registerHttp(
  fixture: ServeFixture,
  name: string,
  protocol: 'auto' | 'stateless',
  env: Record<string, string>,
): Promise<void> {
  const url = await startHttpFixture(HTTP_STATELESS_FIXTURE, env)
  await fixture.registry.addServer({ name, transport: 'http', url, protocol })
  await grant(fixture, name)
}

interface Pool {
  call(body: unknown): Promise<Record<string, unknown>>
}

async function openPool(fixture: ServeFixture): Promise<Pool> {
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
  return {
    call: async (body) => {
      const answer = await fixture.post(JSON.stringify(body), { 'mcp-session-id': sessionId }, POOL)
      const text = await answer.text()
      return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>)
    },
  }
}

async function listNames(pool: Pool, id = 2): Promise<string[]> {
  const body = await pool.call({ jsonrpc: '2.0', id, method: 'tools/list' })
  const tools = (body['result'] as { tools?: { name: string }[] } | undefined)?.tools ?? []
  return tools.map((tool) => tool.name)
}

/** The echoed text of a `tools/call` answer, parsed. */
async function callEcho(pool: Pool, id: number, name: string): Promise<Record<string, unknown>> {
  const body = await pool.call({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: { text: 'hi' }, _meta: { progressToken: `p-${id}` } },
  })
  const content = (body['result'] as { content?: { text: string }[] } | undefined)?.content ?? []
  expect(content[0]?.text, JSON.stringify(body)).toBeDefined()
  return JSON.parse(content[0]?.text as string) as Record<string, unknown>
}

function poolEvents(records: readonly JournalRecord[], event: string): Array<Record<string, unknown>> {
  return records
    .filter((record) => record.kind === 'pool')
    .map((record) => record.payload as Record<string, unknown>)
    .filter((payload) => payload['event'] === event)
}

describe('a stdio member that speaks only 2026-07-28', () => {
  test('is listed and called, and every frame it gets carries the revision’s `_meta`', async () => {
    // Arrange
    const fixture = await startServe()
    await registerStdio(fixture, 'modern', POOL_MODERN_SERVER, ['echo'])
    const pool = await openPool(fixture)

    // Act
    const names = await listNames(pool)
    const echoed = await callEcho(pool, 3, 'modern__echo')

    // Assert
    expect(names).toEqual(['modern__echo'])
    const params = echoed['params'] as { name: string; _meta: Record<string, unknown> }
    expect(params.name).toBe('echo')
    expect(params._meta[PROTOCOL_KEY]).toBe('2026-07-28')
    expect(params._meta['io.modelcontextprotocol/clientCapabilities']).toEqual({})
    // The agent's own `_meta` survived the stamp.
    expect(params._meta['progressToken']).toBe('p-3')
  })

  test('a result that is not finished reaches the agent as -32007, and is noted', async () => {
    // Arrange
    const fixture = await startServe()
    await registerStdio(fixture, 'modern', POOL_MODERN_SERVER, ['needs_input'])
    const pool = await openPool(fixture)
    await listNames(pool)

    // Act
    const body = await pool.call({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'modern__needs_input', arguments: {} },
    })

    // Assert
    expect((body['error'] as { code: number }).code).toBe(-32007)
    await waitUntil(
      async () => poolEvents(await fixture.journalRecords(), 'dropped').length > 0,
      'the incomplete-result record',
    )
    expect(poolEvents(await fixture.journalRecords(), 'dropped')).toContainEqual(
      expect.objectContaining({ serverName: 'modern', reason: 'incomplete-result' }),
    )
  })
})

describe('a dual-mode stdio member', () => {
  test('stays sessionful: its frames are not stamped', async () => {
    // Arrange
    const fixture = await startServe()
    await registerStdio(fixture, 'dual', POOL_MODERN_SERVER, ['echo'], { POOL_MODERN_DUAL: '1' })
    const pool = await openPool(fixture)
    await listNames(pool)

    // Act
    const echoed = await callEcho(pool, 3, 'dual__echo')

    // Assert
    const params = echoed['params'] as { _meta: Record<string, unknown> }
    expect(params._meta).toEqual({ progressToken: 'p-3' })
  })
})

describe('an HTTP member that refuses the handshake (STRICT)', () => {
  test('registered `stateless` is listed and called, with the headers of its revision', async () => {
    // Arrange
    const fixture = await startServe()
    await registerHttp(fixture, 'remote', 'stateless', { STRICT: '1' })
    const pool = await openPool(fixture)

    // Act
    const names = await listNames(pool)
    const echoed = await callEcho(pool, 3, 'remote__echo')

    // Assert
    expect(names).toEqual(['remote__echo'])
    expect(echoed['receivedHeaders']).toMatchObject({
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'echo',
      'mcp-session-id': null,
    })
  })

  test('registered `auto` is negotiated to stateless', async () => {
    // Arrange
    const fixture = await startServe()
    await registerHttp(fixture, 'remote', 'auto', { STRICT: '1' })
    const pool = await openPool(fixture)

    // Act
    const names = await listNames(pool)
    const echoed = await callEcho(pool, 3, 'remote__echo')

    // Assert
    expect(names).toEqual(['remote__echo'])
    expect(echoed['receivedHeaders']).toMatchObject({ 'mcp-protocol-version': '2026-07-28' })
  })

  test('its 4xx error STATUS is an answer to the call, not the end of the member (RV4)', async () => {
    // Arrange
    const fixture = await startServe()
    await registerHttp(fixture, 'remote', 'stateless', { STRICT: '1' })
    const pool = await openPool(fixture)
    await listNames(pool)

    // Act — a tool the server does not have: 400 + -32602, as the spec says.
    const refused = await pool.call({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'remote__nope', arguments: {} },
    })
    const echoed = await callEcho(pool, 4, 'remote__echo')

    // Assert
    expect((refused['error'] as { code: number }).code).toBe(-32602)
    expect(echoed['params']).toMatchObject({ name: 'echo' })
    // And it never left. Given time to show up if it did.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const records = await fixture.journalRecords()
    expect(poolEvents(records, 'detach')).toEqual([])
    expect(poolEvents(records, 'attach')).toHaveLength(1)
  })
})

describe('a pool of both revisions', () => {
  test('lists every member, in the same order every time', async () => {
    // Arrange
    const fixture = await startServe()
    await registerStdio(fixture, 'old', POOL_SERVER, ['echo'])
    await registerStdio(fixture, 'modern', POOL_MODERN_SERVER, ['query'])
    await registerHttp(fixture, 'remote', 'stateless', { STRICT: '1', STRICT_TOOLS: 'fetch' })
    const pool = await openPool(fixture)

    // Act
    const first = await listNames(pool, 2)
    const second = await listNames(pool, 3)

    // Assert
    expect(first).toEqual(['modern__query', 'old__echo', 'remote__fetch'])
    expect(second).toEqual(first)
  })
})
