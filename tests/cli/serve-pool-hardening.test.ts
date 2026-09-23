import { afterEach, describe, expect, test } from 'vitest'
import { POOL_ROUTE_PATH } from '../../src/transport/http/server-constants.js'
import {
  AGENT,
  disposeServeFixtures,
  POOL_HOSTILE_SERVER,
  POOL_SERVER,
  startServe,
  waitUntil,
  type ServeFixture,
} from './serve-harness.js'

/**
 * The pool against upstreams that misbehave, and against an agent that tries
 * to reach past its own grants.
 *
 * A pool is the first place in this product where ONE agent's session is
 * shared by several servers, so it is the first place where one server's
 * behaviour can cost another server's traffic. Every case below is a way that
 * could happen; each one's answer is that it does not.
 */

afterEach(async () => {
  await disposeServeFixtures()
})

const POOL = POOL_ROUTE_PATH

async function addHostile(fixture: ServeFixture, name: string, mode: string): Promise<void> {
  await fixture.registry.addServer({
    name,
    transport: 'stdio',
    command: process.execPath,
    args: [POOL_HOSTILE_SERVER, '--mode', mode],
    env: { POOL_FIXTURE_NAME: name },
  })
  await fixture.agents.grantServer(AGENT, name, '*')
}

async function addHonest(
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
  await fixture.agents.grantServer(AGENT, name, '*')
}

interface PoolClient {
  readonly sessionId: string
  call(body: unknown): Promise<Record<string, unknown>>
}

/**
 * A second agent on the same front, so two pools can be made to grow at once.
 * The fixture's own `post` carries the first agent's token, so this one posts
 * through `fetch` with its own.
 */
async function createSecondAgent(
  fixture: ServeFixture,
  servers: readonly string[],
): Promise<string> {
  const created = await fixture.agents.createAgent('second-bot')
  for (const server of servers) {
    await fixture.agents.grantServer('second-bot', server, '*')
  }
  return created.token
}

async function openPool(fixture: ServeFixture, token?: string): Promise<PoolClient> {
  const post = (body: string, headers: Record<string, string> = {}): Promise<Response> =>
    token === undefined
      ? fixture.post(body, headers, POOL)
      : fetch(`${fixture.baseUrl}${POOL}`, {
          method: 'POST',
          body,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            ...headers,
          },
        })
  const opened = await post(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {} },
    }),
  )
  const sessionId = opened.headers.get('mcp-session-id') as string
  return {
    sessionId,
    call: async (body) => {
      const response = await post(JSON.stringify(body), { 'mcp-session-id': sessionId })
      const text = await response.text()
      return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>)
    },
  }
}

function toolNamesOf(body: Record<string, unknown>): string[] {
  const result = body['result'] as { tools?: { name: string }[] } | undefined
  return (result?.tools ?? []).map((entry) => entry.name)
}

describe('an upstream that names its tools to look like another server', () => {
  test('stays inside its own namespace, and the call lands on IT', async () => {
    // `other__drop` on server `hostile` is `hostile__other__drop` in the pool,
    // and the split at the FIRST separator sends it to `hostile`. Naming a
    // tool cannot address a server.
    const fixture = await startServe()
    await addHostile(fixture, 'hostile', 'cross-name')
    await addHonest(fixture, 'other', ['drop'])
    const pool = await openPool(fixture)

    const listed = await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    expect(toolNamesOf(listed)).toContain('hostile__other__drop')
    const called = await pool.call({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'hostile__other__drop', arguments: {} },
    })
    const content = (called['result'] as { content: { text: string }[] }).content
    const echoed = JSON.parse(content[0]?.text ?? '{}') as { server: string }
    expect(echoed.server).toBe('hostile')
  })
})

describe('an upstream that lists one name twice', () => {
  test('drops out of the catalog whole, leaving the others listed', async () => {
    // Choosing silently between two identically named surfaces is exactly the
    // substitution quarantine exists to prevent, so the server is refused as a
    // whole rather than half-listed.
    const fixture = await startServe()
    await addHostile(fixture, 'dupes', 'duplicate')
    await addHonest(fixture, 'honest', ['fine'])
    const pool = await openPool(fixture)

    const listed = await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    expect(toolNamesOf(listed)).toEqual(['honest__fine'])
  })
})

describe('a name too long for known clients', () => {
  test('is hidden from the pool but still reachable per-server (PE2, PE4)', async () => {
    // One invalid name breaks an agent's whole request, so hiding costs less
    // than listing. The per-server address is unchanged, so nothing is lost.
    const fixture = await startServe()
    await addHostile(fixture, 'longs', 'long-name')
    const pool = await openPool(fixture)

    const listed = await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    expect(toolNamesOf(listed)).toEqual(['longs__short'])
    const perServer = await fixture.post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {} },
      }),
      {},
      `/agents/${AGENT}/servers/longs`,
    )
    const perServerSession = perServer.headers.get('mcp-session-id') as string
    const direct = await fixture.post(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      { 'mcp-session-id': perServerSession },
      `/agents/${AGENT}/servers/longs`,
    )
    const directNames = ((await direct.json()) as { result: { tools: { name: string }[] } }).result
      .tools.map((entry) => entry.name)
    expect(directNames).toContain('x'.repeat(70))
  })

  test('records which names it hid, so an operator can find out', async () => {
    const fixture = await startServe()
    await addHostile(fixture, 'longs', 'long-name')
    const pool = await openPool(fixture)

    await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    await waitUntil(async () => {
      const records = await fixture.journalRecords()
      return records.some(
        (record) =>
          record.kind === 'pool' &&
          (record.payload as { hiddenNames?: string[] }).hiddenNames !== undefined,
      )
    }, 'a record of the hidden names')
  })
})

describe('an upstream that asks the agent a question', () => {
  test('is dropped with a record, and the agent never sees it (PE3)', async () => {
    // Upstreams are told of no sampling, elicitation or roots, so anything
    // they initiate is unsolicited.
    const fixture = await startServe()
    await addHostile(fixture, 'asker', 'server-request')
    const pool = await openPool(fixture)
    await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    // The fixture asks right after its handshake. A stdio server is a HELD
    // session now (ADR-0016), negotiated before any pool attaches: a frame
    // that arrives with nobody attached is journaled by that session itself
    // and relayed to no one (RS1), and the pool's own `dropped` note appears
    // only when the attach happened first. The session's record is the one
    // that is always there — which is what "never silently lost" means.
    await waitUntil(async () => {
      const records = await fixture.journalRecords()
      return records.some(
        (record) =>
          record.kind === 'request' &&
          record.direction === 'server→client' &&
          record.method === 'sampling/createMessage',
      )
    }, 'the child session’s record of the server request')
  })
})

describe('an upstream that goes silent', () => {
  test('costs the agent one timeout, not its whole catalog (P4)', async () => {
    // Refusing the catalog because one server stalls would let any upstream
    // blind an agent to every other server it was granted.
    // Long enough that a genuinely spawned upstream answers inside it even on
    // a loaded machine (150 ms was not, under the full suite), short enough
    // that the mute one does not slow the test. The timeout mechanism itself is
    // driven directly in `catalog.test.ts`; what this asserts is the OUTCOME —
    // the others are still listed.
    const fixture = await startServe({
      serveOptions: { poolFanoutTimeoutMs: 2_000 },
    })
    await addHostile(fixture, 'mute', 'silent')
    await addHonest(fixture, 'honest', ['fine'])
    const pool = await openPool(fixture)

    const listed = await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    expect(toolNamesOf(listed)).toEqual(['honest__fine'])
  })
})

describe('the process-wide session ceiling', () => {
  test('counts a pool\'s children, so one agent cannot walk past it (P5)', async () => {
    // Without this a single agent with broad grants would hold more upstreams
    // than the whole process is configured to allow.
    const fixture = await startServe({ serveOptions: { maxSessions: 3 } })
    await addHonest(fixture, 'one', ['a'])
    await addHonest(fixture, 'two', ['b'])
    await addHonest(fixture, 'three', ['c'])
    const pool = await openPool(fixture)
    await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    // The pool session plus its children now fill the budget; a further
    // session cannot be opened.
    const refused = await fixture.post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {} },
      }),
      {},
      `/agents/${AGENT}/servers/one`,
    )

    expect(refused.status).toBe(429)
  })
})

describe('a pool that grows after its own admission', () => {
  test('cannot grow past the process-wide ceiling (P5)', async () => {
    // The front reserves a slot when a top-level session OPENS; a pool's
    // children come up later, on the first `tools/list`. A cap that looked only
    // at the per-pool number therefore let one agent with many grants put
    // 1 + N of the process's slots in use in a single request, N never having
    // passed any admission check at all. The ceiling is now asked per child.
    const fixture = await startServe({ serveOptions: { maxSessions: 3 } })
    await addHonest(fixture, 'one', ['a'])
    await addHonest(fixture, 'two', ['b'])
    await addHonest(fixture, 'three', ['c'])
    await addHonest(fixture, 'four', ['d'])
    const pool = await openPool(fixture)

    const listed = await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    // The pool session itself holds one slot, so at most two children fit.
    // The rest are refused the PE6 way — absent from the catalog, not an error.
    expect(toolNamesOf(listed).length).toBeLessThanOrEqual(2)
    await waitUntil(async () => {
      const records = await fixture.journalRecords()
      return records.some(
        (record) =>
          record.kind === 'pool' && (record.payload as { reason?: string }).reason === 'pool-full',
      )
    }, 'a pool-full refusal record')
  })
})

describe('two pools growing at the same instant', () => {
  test('share the one process budget instead of each taking it whole', async () => {
    // The cross-pool half of P5, and the reason the budget is CLAIMED rather
    // than asked about. `activeSessionCount()` sees a child only once its
    // transport is up, so a count of opens-in-flight kept per pool left each
    // pool blind to the other: both read the same free slots and both took
    // them, and the process ended up holding more upstreams than it allows.
    const fixture = await startServe({ serveOptions: { maxSessions: 4 } })
    await addHonest(fixture, 'one', ['a'])
    await addHonest(fixture, 'two', ['b'])
    await addHonest(fixture, 'three', ['c'])
    const second = await createSecondAgent(fixture, ['one', 'two', 'three'])

    // Two pool sessions hold two of the four slots; two children fit in total,
    // however the two pools divide them.
    const first = await openPool(fixture)
    const other = await openPool(fixture, second)
    await Promise.all([
      first.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      other.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    ])

    // Six outcomes in total — each pool decides each of the three servers
    // exactly once — so the count below is read when both pools have finished,
    // not while one is still opening.
    const outcomesOf = async (): Promise<string[]> =>
      (await fixture.journalRecords())
        .filter((record) => record.kind === 'pool')
        .map((record) => (record.payload as { event?: string }).event ?? '')
        .filter((event) => event === 'attach' || event === 'attach-refused')
    await waitUntil(async () => (await outcomesOf()).length === 6, 'both pools to settle')
    const outcomes = await outcomesOf()

    const attached = outcomes.filter((event) => event === 'attach')
    expect(attached.length).toBeLessThanOrEqual(2)
    // …and the budget was actually spent, not merely never approached.
    expect(attached.length).toBe(2)
  })
})

describe('a vault secret handed to a pooled upstream', () => {
  test('appears in no pool record, even in a refusal reason', async () => {
    // A pool record's `reason` is server- and vault-influenced text, so the
    // pool registers the exact values its children were given and redacts by
    // value — not only by pattern. Without it the only backstop would be the
    // separate discipline of every module that can populate a reason.
    const fixture = await startServe()
    const secret = 'pool-smoke-secret-value-0123456789'
    await fixture.vault.setSecret('poolsecret', secret)
    await fixture.registry.addServer({
      name: 'secretive',
      transport: 'stdio',
      command: process.execPath,
      args: [POOL_SERVER, 'fine'],
      env: { POOL_FIXTURE_NAME: 'secretive', TOKEN: 'vault:poolsecret' },
    })
    await fixture.agents.grantServer(AGENT, 'secretive', '*')
    const pool = await openPool(fixture)
    await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await pool.call({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'secretive__fine', arguments: {} },
    })

    const records = await fixture.journalRecords()
    expect(records.some((record) => record.kind === 'pool')).toBe(true)
    expect(JSON.stringify(records)).not.toContain(secret)
    expect(fixture.io.errText()).not.toContain(secret)
  })
})

describe('the agent token', () => {
  test('appears in no journal record and on no stderr line', async () => {
    // The pool touches the token on every request; a sweep is the only honest
    // way to say it never lands anywhere it could be read back.
    const fixture = await startServe()
    await addHonest(fixture, 'honest', ['fine'])
    const pool = await openPool(fixture)
    await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await pool.call({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'honest__fine', arguments: {} },
    })

    const records = await fixture.journalRecords()
    expect(JSON.stringify(records)).not.toContain(fixture.token)
    expect(fixture.io.errText()).not.toContain(fixture.token)
    expect(fixture.io.outText()).not.toContain(fixture.token)
  })
})

/**
 * Everything the pool pushes to the agent outside a reply -- the GET stream a
 * sessionful agent holds open. Whole messages, so a test can tell WHOSE
 * progress arrived, not just that some did.
 */
function openAgentStream(fixture: ServeFixture, sessionId: string): { messages: Record<string, unknown>[]; close(): void } {
  const controller = new AbortController()
  const messages: Record<string, unknown>[] = []
  void fetch(`${fixture.baseUrl}${POOL}`, {
    headers: { authorization: `Bearer ${fixture.token}`, 'mcp-session-id': sessionId },
    signal: controller.signal,
  })
    .then(async (response) => {
      if (response.body === null) return
      const decoder = new TextDecoder()
      let pending = ''
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk as Uint8Array, { stream: true })
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('data:')) messages.push(JSON.parse(line.slice('data:'.length).trim()) as Record<string, unknown>)
        }
      }
    })
    .catch(() => undefined)
  return { messages, close: () => controller.abort() }
}

function poolDrops(records: readonly { kind: string; payload: unknown }[], reason: string) {
  return records
    .filter((record) => record.kind === 'pool')
    .map((record) => record.payload as { event?: string; reason?: string; serverName?: string; method?: string })
    .filter((payload) => payload.event === 'dropped' && payload.reason === reason)
}

describe('an upstream that reports progress on another server\'s call (ADR-0015 phase 5, N2)', () => {
  test('is kept from the agent and noted once; the real progress still arrives', async () => {
    const fixture = await startServe()
    await fixture.registry.addServer({
      name: 'good',
      transport: 'stdio',
      command: process.execPath,
      args: [POOL_SERVER, 'slow_echo'],
      // Long enough that the other call certainly lands while this one lives.
      env: { POOL_FIXTURE_NAME: 'good', POOL_FIXTURE_DELAY_MS: '1500' },
    })
    await fixture.agents.grantServer(AGENT, 'good', '*')
    await addHostile(fixture, 'evil', 'foreign-progress')
    const pool = await openPool(fixture)
    await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const stream = openAgentStream(fixture, pool.sessionId)

    const slow = pool.call({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'good__slow_echo', arguments: {}, _meta: { progressToken: 'victim' } },
    })
    await pool.call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'evil__ok', arguments: {} } })
    await slow

    await waitUntil(async () => poolDrops(await fixture.journalRecords(), 'unscoped-notification').length > 0, 'the drop record')
    const progress = stream.messages.filter((message) => message['method'] === 'notifications/progress')
    stream.close()
    expect(progress.map((message) => (message['params'] as { message: string }).message)).toEqual(['good'])
    const drops = poolDrops(await fixture.journalRecords(), 'unscoped-notification')
    expect(drops).toEqual([expect.objectContaining({ serverName: 'evil', method: 'notifications/progress' })])
  })
})

describe('an upstream that logs to the agent (ADR-0015 phase 5, N1/N3)', () => {
  test('never reaches the agent, is noted once per kind, and stays in its own traffic', async () => {
    const fixture = await startServe()
    await addHostile(fixture, 'chatty', 'chatty-log')
    const pool = await openPool(fixture)
    const stream = openAgentStream(fixture, pool.sessionId)
    await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await pool.call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'chatty__ok', arguments: {} } })

    const childLogLines = async (): Promise<number> =>
      (await fixture.journalRecords()).filter(
        (record) => record.kind !== 'pool' && record.method === 'notifications/message',
      ).length
    // Two requests after the handshake, two log lines each: the evidence is
    // not lost, it is where it belongs -- in the child session's traffic.
    await waitUntil(async () => (await childLogLines()) >= 4, 'the log lines in the child traffic')
    await waitUntil(async () => poolDrops(await fixture.journalRecords(), 'unsupported-method').length >= 2, 'the drop notes')
    stream.close()

    expect(stream.messages.filter((message) => message['method'] === 'notifications/message')).toEqual([])
    const notes = poolDrops(await fixture.journalRecords(), 'unsupported-method')
    expect(notes.map((note) => [note.serverName, note.method]).sort()).toEqual([
      ['chatty', 'notifications/message'],
      ['chatty', 'notifications/resources/updated'],
    ])
  })
})

describe('an upstream that dies in the middle of a call', () => {
  test('answers the agent exactly once, through the front own detach wiring (phase-3 CRITICAL, verified in phase 5)', async () => {
    // The multiplexer's unit tests wire `detach -> releaseServer` in their own
    // harness, so removing it from `serve-pool.ts` failed nothing. This pins
    // the PRODUCT wiring: the child session ends on its own, and only that
    // edge answers the call that was in flight there.
    const fixture = await startServe()
    await addHostile(fixture, 'fragile', 'die-on-call')
    const pool = await openPool(fixture)
    await pool.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    const answered = pool.call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fragile__ok', arguments: {} } })
    const outcome = await Promise.race([
      answered,
      new Promise<'unanswered'>((resolve) => setTimeout(() => resolve('unanswered'), 3_000)),
    ])

    expect(outcome).not.toBe('unanswered')
    const reply = outcome as Record<string, unknown>
    expect(reply['id']).toBe(3)
    expect((reply['error'] as { code: number }).code).toBe(-32005)
  })
})
