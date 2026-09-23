import { afterEach, describe, expect, test } from 'vitest'
import { POOL_ROUTE_PATH } from '../../src/transport/http/server-constants.js'
import {
  AGENT,
  disposeServeFixtures,
  POLL_INTERVAL_MS,
  POOL_SERVER,
  startServe,
  waitUntil,
  type ServeFixture,
} from './serve-harness.js'

/**
 * The pool address against a LIVE `serve`: real stores, real policy, real
 * child sessions over real spawned upstreams.
 *
 * What these tests are really checking is that the pool bought its
 * aggregation without changing anything underneath it. The per-server address
 * keeps working in the same process, the decisions the children record are the
 * per-server ones, and the bare tool name is what every enforcement module
 * still sees (PE11).
 */

afterEach(async () => {
  await disposeServeFixtures()
})

const POOL = POOL_ROUTE_PATH

/** Registers one spawned fixture under `name`, exposing the given tools. */
async function register(
  fixture: ServeFixture,
  name: string,
  tools: readonly string[],
): Promise<void> {
  await fixture.registry.addServer({
    name,
    transport: 'stdio',
    command: process.execPath,
    args: [POOL_SERVER, ...tools],
    env: { POOL_FIXTURE_NAME: name },
  })
}

interface PoolSession {
  readonly sessionId: string
  /** POSTs one JSON-RPC body on the pool session and decodes the answer. */
  call(body: unknown): Promise<{ status: number; body: Record<string, unknown> }>
}

/** Opens a pool session with an `initialize`, as an agent's client does. */
async function openPool(fixture: ServeFixture): Promise<PoolSession> {
  const response = await fixture.post(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {} },
    }),
    {},
    POOL,
  )
  expect(response.status).toBe(200)
  const sessionId = response.headers.get('mcp-session-id')
  expect(sessionId).toBeTruthy()

  return {
    sessionId: sessionId as string,
    call: async (body) => {
      const answer = await fixture.post(
        JSON.stringify(body),
        { 'mcp-session-id': sessionId as string },
        POOL,
      )
      const text = await answer.text()
      return {
        status: answer.status,
        body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
      }
    },
  }
}

function toolNamesOf(body: Record<string, unknown>): string[] {
  const result = body['result'] as { tools?: { name: string }[] } | undefined
  return (result?.tools ?? []).map((entry) => entry.name)
}

describe('opening a pool session', () => {
  test('the plane answers initialize as the server at this address (PE12)', async () => {
    // Arrange
    const fixture = await startServe({ grant: '*' })

    // Act
    const response = await fixture.post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {} },
      }),
      {},
      POOL,
    )

    // Assert
    expect(response.status).toBe(200)
    expect(response.headers.get('mcp-session-id')).toBeTruthy()
    const body = (await response.json()) as { result: { serverInfo: { name: string } } }
    expect(body.result.serverInfo.name).toBe('mcpcut')
  })

  test('records the open with the servers in the pool', async () => {
    const fixture = await startServe({ grant: '*' })
    await register(fixture, 'alpha', ['echo'])

    await openPool(fixture)

    await waitUntil(async () => {
      const records = await fixture.journalRecords()
      return records.some((record) => record.kind === 'pool')
    }, 'a pool record')
    const records = await fixture.journalRecords()
    const open = records.find(
      (record) => record.kind === 'pool' && (record.payload as { event: string }).event === 'open',
    )
    expect(open?.payload).toMatchObject({ agentName: AGENT, event: 'open' })
  })

  test('every attach record names the server AND the child session it opened', async () => {
    // Both halves matter and both were once lost to a spread that read fine:
    // `childSessionId` is the binding a report needs to tie a pooled call to
    // the per-server decision underneath it, and without `serverName` the line
    // says a child came up but not to what.
    const fixture = await startServe({ grant: '*' })
    await register(fixture, 'alpha', ['echo'])
    await fixture.agents.grantServer(AGENT, 'alpha', '*')
    const pool = await openPool(fixture)
    await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    await waitUntil(async () => {
      const records = await fixture.journalRecords()
      return records.some(
        (record) =>
          record.kind === 'pool' && (record.payload as { event: string }).event === 'attach',
      )
    }, 'an attach record')

    const records = await fixture.journalRecords()
    const attach = records.find(
      (record) => record.kind === 'pool' && (record.payload as { event: string }).event === 'attach',
    )
    expect(attach?.payload).toMatchObject({ serverName: 'alpha' })
    expect((attach?.payload as { childSessionId?: string }).childSessionId).toBeTruthy()
  })

  test('a server that will not come up is recorded WITH its name and reason (PE6)', async () => {
    // The pool opens without it, so this record is the only place an operator
    // learns which server was left out and why.
    const fixture = await startServe({ grant: '*' })
    // Granted, but never registered: `openChild` refuses it.
    await fixture.agents.grantServer(AGENT, 'ghost', '*')
    const pool = await openPool(fixture)
    await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    // Looked up by NAME: the harness's default grant is to another
    // unregistered server, so this pool refuses more than one.
    const ghostRefusal = async () =>
      (await fixture.journalRecords()).find((record) => {
        const payload = record.payload as { event?: string; serverName?: string }
        return (
          record.kind === 'pool' &&
          payload.event === 'attach-refused' &&
          payload.serverName === 'ghost'
        )
      })
    await waitUntil(async () => (await ghostRefusal()) !== undefined, "ghost's refusal record")

    expect((await ghostRefusal())?.payload).toMatchObject({
      serverName: 'ghost',
      reason: 'unknown-server',
    })
  })

  test('refuses a stateless agent, because the first version is sessionful (PE3)', async () => {
    const fixture = await startServe({ grant: '*' })

    // A well-formed stateless POST: no session id, not an `initialize`, and
    // carrying the per-message headers SEP-2243 requires — so it reaches the
    // pool factory rather than stopping at header validation.
    const response = await fixture.post(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      { 'mcp-method': 'tools/list' },
      POOL,
    )

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('pool-sessionful-only')
  })

  test('a revoked agent never gets as far as the pool', async () => {
    // The front's own authentication rejects a revoked agent's token with the
    // uniform 401, before any route is answered. The pool's `no-grant` refusal
    // exists for the narrower race — a revocation landing between that check
    // and the session opening — and an agent cannot tell the two apart, which
    // is the point.
    const fixture = await startServe({ grant: '*' })
    await fixture.agents.revokeAgent(AGENT)

    const response = await fixture.post(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      {},
      POOL,
    )

    expect(response.status).toBe(401)
  })

  test('an unauthenticated pool request gets the same 401 as any other path', async () => {
    // The route sits after authentication, so its existence is never an oracle.
    const fixture = await startServe({ grant: '*' })

    const response = await fetch(`${fixture.baseUrl}${POOL}`, { method: 'GET' })

    expect(response.status).toBe(401)
  })
})

describe('the merged catalog', () => {
  test('lists every granted server under its own prefix', async () => {
    const fixture = await startServe({ grant: '*' })
    await register(fixture, 'alpha', ['echo'])
    await register(fixture, 'beta', ['query'])
    await fixture.agents.grantServer(AGENT, 'alpha', '*')
    await fixture.agents.grantServer(AGENT, 'beta', '*')
    const pool = await openPool(fixture)

    const listed = await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    expect(listed.status).toBe(200)
    expect(toolNamesOf(listed.body)).toEqual(['alpha__echo', 'beta__query'])
  })

  test('answers an empty list for an agent with no grants at all', async () => {
    const fixture = await startServe()
    const pool = await openPool(fixture)

    const listed = await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    expect(toolNamesOf(listed.body)).toEqual([])
  })

  test('opens no upstream before the first list (PE7)', async () => {
    const fixture = await startServe({ grant: '*' })
    await register(fixture, 'alpha', ['echo'])
    await fixture.agents.grantServer(AGENT, 'alpha', '*')

    await openPool(fixture)

    // The fixture writes a line to stderr when it starts; nothing has.
    expect(fixture.io.errText()).not.toContain('alpha: starting')
  })
})

describe('calling through the pool', () => {
  test('reaches the right upstream with the BARE tool name (PE11)', async () => {
    const fixture = await startServe({ grant: '*' })
    await register(fixture, 'alpha', ['echo'])
    await fixture.agents.grantServer(AGENT, 'alpha', '*')
    const pool = await openPool(fixture)
    await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    const called = await pool.call({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'alpha__echo', arguments: { hello: 'world' } },
    })

    expect(called.status).toBe(200)
    const result = called.body['result'] as { content: { text: string }[] }
    const echoed = JSON.parse(result.content[0]?.text ?? '{}') as {
      server: string
      params: { name: string }
    }
    expect(echoed.server).toBe('alpha')
    // The upstream saw `echo`, not `alpha__echo`.
    expect(echoed.params.name).toBe('echo')
  })

  test('refuses a server outside the pool without naming what exists', async () => {
    const fixture = await startServe({ grant: '*' })
    await register(fixture, 'alpha', ['echo'])
    await register(fixture, 'secret', ['hidden'])
    await fixture.agents.grantServer(AGENT, 'alpha', '*')
    const pool = await openPool(fixture)
    await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    const called = await pool.call({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'secret__hidden', arguments: {} },
    })

    const error = called.body['error'] as { code: number; message: string }
    expect(error.code).toBe(-32602)
    expect(error.message).not.toContain('registered')
  })

  test('answers several calls in flight at once, each with its own reply (P1)', async () => {
    // Without response correlation the front would 409 everything after the
    // first, and the parallelism a pool exists for would be unreachable.
    const fixture = await startServe({ grant: '*' })
    await register(fixture, 'alpha', ['echo'])
    await register(fixture, 'beta', ['query'])
    await fixture.agents.grantServer(AGENT, 'alpha', '*')
    await fixture.agents.grantServer(AGENT, 'beta', '*')
    const pool = await openPool(fixture)
    await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    const [first, second] = await Promise.all([
      pool.call({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'alpha__echo', arguments: {} },
      }),
      pool.call({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'beta__query', arguments: {} },
      }),
    ])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.body['id']).toBe(10)
    expect(second.body['id']).toBe(11)
  })

  test('refuses a method the pool serves no capability for (PE3)', async () => {
    const fixture = await startServe({ grant: '*' })
    const pool = await openPool(fixture)

    const called = await pool.call({ jsonrpc: '2.0', id: 2, method: 'resources/list' })

    expect((called.body['error'] as { code: number }).code).toBe(-32601)
  })
})

describe('the per-server address in the same process', () => {
  test('still works, and the pool did not touch it', async () => {
    const fixture = await startServe({ grant: '*', grantServer: 'alpha' })
    await register(fixture, 'alpha', ['echo'])

    const perServer = await fixture.post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {} },
      }),
      {},
      `/agents/${AGENT}/servers/alpha`,
    )

    expect(perServer.status).toBe(200)
    const body = (await perServer.json()) as { result: { serverInfo: { name: string } } }
    // Forwarded from the upstream, NOT synthesized: only a pool address makes
    // the plane the server (ADR-0002 §4 still holds everywhere else).
    expect(body.result.serverInfo.name).toBe('alpha')
  })
})

describe('closing', () => {
  test('DELETE ends the pool session', async () => {
    const fixture = await startServe({ grant: '*' })
    const pool = await openPool(fixture)

    const deleted = await fixture.del({ 'mcp-session-id': pool.sessionId }, POOL)

    expect(deleted.status).toBe(204)
    const after = await pool.call({ jsonrpc: '2.0', id: 9, method: 'ping' })
    expect(after.status).toBe(404)
  })

  test('records the close', async () => {
    const fixture = await startServe({ grant: '*' })
    const pool = await openPool(fixture)

    await fixture.del({ 'mcp-session-id': pool.sessionId }, POOL)

    await waitUntil(async () => {
      const records = await fixture.journalRecords()
      return records.some(
        (record) =>
          record.kind === 'pool' && (record.payload as { event: string }).event === 'close',
      )
    }, 'a pool close record')
  })

  test('a revoked agent loses its pool session', async () => {
    const fixture = await startServe({
      grant: '*',
      serveOptions: { revocationPollIntervalMs: POLL_INTERVAL_MS },
    })
    await openPool(fixture)

    await fixture.agents.revokeAgent(AGENT)

    // Asserted on the journal rather than on a status code: once the agent is
    // revoked its token no longer authenticates, so every request it could
    // make is answered 401 by the front before a route is even considered.
    // The close record is the evidence that the SESSION went away, which is a
    // different fact from "this caller is no longer allowed in".
    await waitUntil(async () => {
      const records = await fixture.journalRecords()
      return records.some(
        (record) =>
          record.kind === 'pool' && (record.payload as { event: string }).event === 'close',
      )
    }, 'the pool session to close')
  })
})
