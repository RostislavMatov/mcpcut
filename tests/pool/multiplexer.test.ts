import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PoolRecordInfo } from '../../src/journal/pool-record.js'
import { createPoolCatalog } from '../../src/pool/catalog.js'
import { createPoolChildren, type OpenPoolChild } from '../../src/pool/children.js'
import {
  ERROR_CODE_POOL_AT_CAPACITY,
  ERROR_CODE_POOL_INVALID_PARAMS,
  ERROR_CODE_POOL_MEMBER_GONE,
  ERROR_CODE_POOL_METHOD_NOT_FOUND,
  MAX_POOL_CHILD_SESSIONS,
  MAX_POOL_PENDING_REQUESTS,
  POOL_FANOUT_ID_PREFIX,
} from '../../src/pool/constants.js'
import { createPoolCorrelator } from '../../src/pool/correlator.js'
import { createPoolFanout } from '../../src/pool/fanout.js'
import { performUpstreamHandshake } from '../../src/pool/handshake.js'
import { createPoolMultiplexer, type PoolMultiplexer } from '../../src/pool/multiplexer.js'
import type { PoolWatch } from '../../src/pool/watch.js'
import { serverMessage, type MessageSink, type MessageSource } from '../../src/transport/message.js'

/**
 * The whole dispatch, on fake child sessions and no IO at all.
 *
 * The cases worth the most here are the adversarial ones. A hostile upstream
 * gets three tries at breaking the pool: name a tool so it looks like it
 * belongs to another server, answer somebody else's in-flight id, or ask the
 * agent a question it never offered to answer. All three are pinned below.
 */

const PLANE_VERSION = '0.1.0'

interface FakeServer {
  /** Lines the pool wrote into this child, in order. */
  readonly seen: string[]
  emit(text: string): void
  /** Fires the child source's `onEnd` — the upstream went away on its own. */
  end(): void
}

interface Harness {
  readonly mux: PoolMultiplexer
  readonly servers: Map<string, FakeServer>
  /** Plane-minted ids already answered, so one request is answered once. */
  readonly answeredIds: Set<string>
  /** Frames the pool sent the agent, decoded. */
  readonly toAgent: Record<string, unknown>[]
  /** The same frames, exactly as the transport would receive them. */
  readonly rawToAgent: Buffer[]
  readonly records: PoolRecordInfo[]
  readonly errors: unknown[]
  /** Pretends the watch saw a new membership, as a grant edit would. */
  membership(granted: readonly string[]): Promise<void>
  setGranted(granted: readonly string[]): void
}

/**
 * The fan-out budget these tests run with. Deliberately generous: a timeout
 * shorter than `vi.waitFor`'s polling interval would fire before any test
 * could answer, and every assertion about merging would then be an assertion
 * about the timeout instead. The timeout itself is covered in `catalog.test.ts`,
 * where it is driven directly.
 */
const FANOUT_BUDGET_MS = 5_000

function createHarness(
  names: readonly string[],
  options: { maxPending?: number; timeoutMs?: number } = {},
): Harness {
  const servers = new Map<string, FakeServer>()
  const toAgent: Record<string, unknown>[] = []
  const rawToAgent: Buffer[] = []
  const records: PoolRecordInfo[] = []
  const errors: unknown[] = []
  let granted = [...names]

  const openChild: OpenPoolChild = (server) => {
    const seen: string[] = []
    let onMessage: ((message: ReturnType<typeof serverMessage>) => void) | null = null
    const sink: MessageSink = {
      write: (message) => {
        const line = message.bytes.toString('utf8')
        seen.push(line)
        // A spec-abiding upstream answers the plane's own `initialize` before
        // it will serve anything else, so the fake does too.
        const parsed = JSON.parse(line) as { id?: string; method?: string }
        if (parsed.method === 'initialize' && parsed.id !== undefined) {
          const id = parsed.id
          queueMicrotask(() =>
            onMessage?.(
              serverMessage(
                Buffer.from(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id,
                    result: {
                      protocolVersion: '2025-11-25',
                      capabilities: { tools: {}, prompts: {} },
                      serverInfo: { name: server, version: '1' },
                    },
                  }),
                  'utf8',
                ),
              ),
            ),
          )
        }
        return Promise.resolve()
      },
      dispose: () => undefined,
    }
    let onEnd: (() => void) | null = null
    const source: MessageSource = {
      onMessage: (handler) => {
        onMessage = handler
      },
      onError: () => undefined,
      onEnd: (handler) => {
        onEnd = handler
      },
      dispose: () => undefined,
    }
    servers.set(server, {
      seen,
      emit: (text) => onMessage?.(serverMessage(Buffer.from(text, 'utf8'))),
      end: () => onEnd?.(),
    })
    return Promise.resolve({
      status: 'opened' as const,
      child: { server, sessionId: `s-${server}`, sink, close: () => Promise.resolve() },
      source,
    })
  }

  const correlator = createPoolCorrelator(options.maxPending ?? MAX_POOL_PENDING_REQUESTS)
  let mux: PoolMultiplexer
  const fanout = createPoolFanout({
    correlator,
    timeoutMs: options.timeoutMs ?? FANOUT_BUDGET_MS,
    onTimeout: (server) => void children.detach(server, 'fanout-timeout'),
  })
  const children = createPoolChildren({
    openChild,
    // The real handshake against the fake upstreams below, so the dispatch
    // tests exercise the same attach path the product does.
    handshake: async (child) =>
      (await performUpstreamHandshake(fanout, child, PLANE_VERSION)) !== null,
    reserveChild: (held) => (held < MAX_POOL_CHILD_SESSIONS ? { release: () => undefined } : null),
    onEvent: (event) => {
      records.push({ agentName: 'bot', ...event } as PoolRecordInfo)
      // The same edge `serve-pool.ts` wires: every departure releases the calls
      // in flight at that server, not only an ungranted one.
      if (event.event === 'detach') mux.releaseServer(event.server)
    },
    onChildMessage: (server, message) => mux.handleChildFrame(server, message),
  })
  const catalog = createPoolCatalog({ fanout, children, maxPages: 10 })
  const watch: PoolWatch = {
    get granted() {
      return granted
    },
    start: () => undefined,
    stop: () => undefined,
  }

  mux = createPoolMultiplexer({
    agentName: 'bot',
    planeVersion: PLANE_VERSION,
    children,
    catalog,
    correlator,
    fanout,
    watch,
    journal: (info) => records.push(info),
    toAgent: (bytes) => {
      rawToAgent.push(bytes)
      toAgent.push(JSON.parse(bytes.toString('utf8')) as Record<string, unknown>)
    },
    onError: (error) => errors.push(error),
  })

  return {
    mux,
    servers,
    answeredIds: new Set<string>(),
    toAgent,
    rawToAgent,
    records,
    errors,
    membership: (next) => {
      granted = [...next]
      return mux.onMembershipChanged(next)
    },
    setGranted: (next) => {
      granted = [...next]
    },
  }
}

function frame(body: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(body), 'utf8')
}

function request(id: number | string, method: string, params?: Record<string, unknown>): Buffer {
  return frame({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
}

/**
 * Waits for the named server's next list request and answers it. Waiting on
 * the REQUEST rather than on the child's existence matters: a child is
 * registered the moment it opens, which is before the fan-out has been
 * written to it.
 */
async function answerList(
  harness: Harness,
  server: string,
  names: readonly string[],
): Promise<void> {
  // The handshake lines come first on every child, so the request being
  // answered is the last LIST request, not simply the last line.
  await vi.waitFor(() => expect(listRequestsOf(harness, server).length).toBeGreaterThan(0))
  const pending = listRequestsOf(harness, server)
  const id = (JSON.parse(pending.at(-1) as string) as { id: string }).id
  harness.answeredIds.add(id)
  harness.servers.get(server)?.emit(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: { tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })) },
    }),
  )
}

/** List requests this server has received and not yet been answered for. */
function listRequestsOf(harness: Harness, server: string): string[] {
  return (harness.servers.get(server)?.seen ?? []).filter((line) => {
    const parsed = JSON.parse(line) as { id?: string; method?: string }
    return (
      parsed.method?.endsWith('/list') === true &&
      parsed.id !== undefined &&
      !harness.answeredIds.has(parsed.id)
    )
  })
}

/** Opens the pool's children by listing once, and clears what the agent saw. */
async function listOnce(
  harness: Harness,
  catalogs: Readonly<Record<string, readonly string[]>>,
): Promise<void> {
  harness.mux.handleAgentFrame(request(1, 'tools/list'))
  await Promise.all(
    Object.entries(catalogs).map(([server, names]) => answerList(harness, server, names)),
  )
  await vi.waitFor(() => expect(harness.toAgent).toHaveLength(1))
  harness.toAgent.length = 0
}

function errorOf(body: Record<string, unknown>): { code: number; message: string } {
  return body['error'] as { code: number; message: string }
}

/**
 * One error reply with the agent's own name blanked out, so two replies can be
 * compared for everything EXCEPT the input they echo.
 */
function withoutEchoedName(body: Record<string, unknown>): unknown {
  const error = body['error'] as { code: number; message: string; data?: { toolName?: string } }
  const echoed = error.data?.toolName ?? ''
  return {
    code: error.code,
    message: echoed === '' ? error.message : error.message.replace(echoed, '<name>'),
    data: { ...error.data, toolName: '<name>' },
  }
}

let harness: Harness

describe('initialize', () => {
  beforeEach(() => {
    harness = createHarness(['fs', 'github'])
  })

  test('is answered by the plane, and opens no child at all (PE7/PE12)', () => {
    // Arrange / Act
    harness.mux.handleAgentFrame(request(1, 'initialize', { protocolVersion: '2025-06-18' }))

    // Assert
    const result = harness.toAgent[0]?.['result'] as Record<string, unknown>
    expect(result['serverInfo']).toEqual({ name: 'mcpcut', version: PLANE_VERSION })
    expect(result['protocolVersion']).toBe('2025-06-18')
    // Tools and prompts only: PE3's first-version scope, and nothing an
    // upstream could use to ask the agent a question.
    expect(Object.keys(result['capabilities'] as object).sort()).toEqual(['prompts', 'tools'])
    expect(harness.servers.size).toBe(0)
  })

  test('swallows the initialized notification instead of fanning it out', () => {
    harness.mux.handleAgentFrame(request(1, 'initialize'))
    harness.toAgent.length = 0

    harness.mux.handleAgentFrame(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }))

    expect(harness.toAgent).toEqual([])
    expect(harness.servers.size).toBe(0)
  })

  test('answers ping itself', () => {
    harness.mux.handleAgentFrame(request(5, 'ping'))

    expect(harness.toAgent[0]).toEqual({ jsonrpc: '2.0', id: 5, result: {} })
  })
})

describe('tools/list', () => {
  beforeEach(() => {
    harness = createHarness(['fs', 'github'])
  })

  test('brings every granted server up on the FIRST list and merges them', async () => {
    // Act
    harness.mux.handleAgentFrame(request(2, 'tools/list'))
    await Promise.all([
      answerList(harness, 'fs', ['read']),
      answerList(harness, 'github', ['create_issue']),
    ])

    // Assert
    await vi.waitFor(() => expect(harness.toAgent).toHaveLength(1))
    const tools = (harness.toAgent[0]?.['result'] as { tools: { name: string }[] }).tools
    expect(tools.map((t) => t.name)).toEqual(['fs__read', 'github__create_issue'])
  })

  test('answers an empty list for an agent with no grants', async () => {
    const empty = createHarness([])

    empty.mux.handleAgentFrame(request(2, 'tools/list'))

    await vi.waitFor(() => expect(empty.toAgent).toHaveLength(1))
    expect(empty.toAgent[0]?.['result']).toEqual({ tools: [] })
  })

  test('refuses a cursor it never issued (P6)', () => {
    harness.mux.handleAgentFrame(request(2, 'tools/list', { cursor: 'page-2' }))

    expect(errorOf(harness.toAgent[0] ?? {}).code).toBe(ERROR_CODE_POOL_INVALID_PARAMS)
    expect(harness.servers.size).toBe(0)
  })

  test('records the names it hid for being too long', async () => {
    harness.mux.handleAgentFrame(request(2, 'tools/list'))
    await Promise.all([
      answerList(harness, 'fs', ['x'.repeat(70)]),
      answerList(harness, 'github', ['ok']),
    ])

    await vi.waitFor(() => expect(harness.toAgent).toHaveLength(1))
    const hidden = harness.records.find((r) => r.reason === 'name-too-long')
    expect(hidden?.hiddenNames).toEqual([`fs__${'x'.repeat(70)}`])
  })
})

describe('tools/call', () => {
  beforeEach(async () => {
    harness = createHarness(['fs', 'github'])
    await listOnce(harness, { fs: ['read'], github: ['create_issue'] })
  })

  test('strips the prefix and sends the BARE name to the right child (PE11)', () => {
    harness.mux.handleAgentFrame(request(10, 'tools/call', { name: 'fs__read', arguments: {} }))

    const sent = JSON.parse(harness.servers.get('fs')?.seen.at(-1) ?? '{}') as {
      params: { name: string }
    }
    expect(sent.params.name).toBe('read')
    expect(harness.servers.get('github')?.seen.at(-1)).not.toContain('"read"')
  })

  test('keeps a hostile tool name inside its OWN server', () => {
    // A server that calls its tool `other__drop` is reachable at
    // `fs__other__drop`, and the split at the FIRST separator sends it to
    // `fs`. Naming a tool cannot address another server.
    harness.mux.handleAgentFrame(
      request(11, 'tools/call', { name: 'fs__other__drop', arguments: {} }),
    )

    const sent = JSON.parse(harness.servers.get('fs')?.seen.at(-1) ?? '{}') as {
      params: { name: string }
    }
    expect(sent.params.name).toBe('other__drop')
  })

  test('answers an unknown server exactly as it answers a prefixless name', () => {
    // "A server outside this pool" and "not a pool name at all" must be
    // indistinguishable: telling them apart would let an agent enumerate the
    // servers the installation holds outside its own grants, one guess at a
    // time. What the reply may echo is the name the agent itself typed — that
    // teaches it nothing it did not already know.
    harness.mux.handleAgentFrame(request(12, 'tools/call', { name: 'db__query', arguments: {} }))
    harness.mux.handleAgentFrame(request(13, 'tools/call', { name: 'noprefix', arguments: {} }))

    const [unknownServer, noPrefix] = harness.toAgent
    expect(errorOf(unknownServer ?? {}).code).toBe(errorOf(noPrefix ?? {}).code)
    expect(withoutEchoedName(unknownServer ?? {})).toEqual(withoutEchoedName(noPrefix ?? {}))
  })

  test('routes two calls to different servers and delivers each its own reply', () => {
    harness.mux.handleAgentFrame(request(20, 'tools/call', { name: 'fs__read', arguments: {} }))
    harness.mux.handleAgentFrame(
      request(21, 'tools/call', { name: 'github__create_issue', arguments: {} }),
    )

    // Replies come back in the OPPOSITE order to the calls.
    harness.servers.get('github')?.emit('{"jsonrpc":"2.0","id":21,"result":{"from":"github"}}')
    harness.servers.get('fs')?.emit('{"jsonrpc":"2.0","id":20,"result":{"from":"fs"}}')

    expect(harness.toAgent).toEqual([
      { jsonrpc: '2.0', id: 21, result: { from: 'github' } },
      { jsonrpc: '2.0', id: 20, result: { from: 'fs' } },
    ])
  })

  test('drops a reply from the WRONG server and tells the agent nothing', () => {
    // The most damaging failure available to a hostile upstream: answering
    // somebody else's in-flight call.
    harness.mux.handleAgentFrame(request(30, 'tools/call', { name: 'fs__read', arguments: {} }))

    harness.servers.get('github')?.emit('{"jsonrpc":"2.0","id":30,"result":{"from":"github"}}')

    expect(harness.toAgent).toEqual([])
    expect(harness.records.some((r) => r.reason === 'uncorrelated-reply')).toBe(true)
    // And the real server can still answer it afterwards.
    harness.servers.get('fs')?.emit('{"jsonrpc":"2.0","id":30,"result":{"from":"fs"}}')
    expect(harness.toAgent).toHaveLength(1)
  })

  test('refuses a duplicate id without disturbing the first call', () => {
    harness.mux.handleAgentFrame(request(40, 'tools/call', { name: 'fs__read', arguments: {} }))
    harness.mux.handleAgentFrame(request(40, 'tools/call', { name: 'fs__read', arguments: {} }))

    expect(errorOf(harness.toAgent[0] ?? {}).code).toBe(ERROR_CODE_POOL_INVALID_PARAMS)
    harness.servers.get('fs')?.emit('{"jsonrpc":"2.0","id":40,"result":{"ok":true}}')
    expect(harness.toAgent).toHaveLength(2)
  })

  test('refuses an id reserved for the plane\'s own requests', () => {
    // Tracking it would let a fan-out reply reach the agent as if it had
    // asked for one (ADR-0015 §3).
    harness.mux.handleAgentFrame(
      request(`${POOL_FANOUT_ID_PREFIX}9`, 'tools/call', { name: 'fs__read', arguments: {} }),
    )

    expect(errorOf(harness.toAgent[0] ?? {}).code).toBe(ERROR_CODE_POOL_INVALID_PARAMS)
  })

  test('says "at capacity" rather than "the server left" when the table is full', async () => {
    // The two send an agent to different remedies, so one code for both would
    // be a lie about what happened.
    const small = createHarness(['fs'], { maxPending: 1 })
    await listOnce(small, { fs: ['read'] })

    small.mux.handleAgentFrame(request(50, 'tools/call', { name: 'fs__read', arguments: {} }))
    small.mux.handleAgentFrame(request(51, 'tools/call', { name: 'fs__read', arguments: {} }))

    expect(errorOf(small.toAgent[0] ?? {}).code).toBe(ERROR_CODE_POOL_AT_CAPACITY)
  })

  test('drops a call whose id is null, because there is nowhere to answer', () => {
    harness.mux.handleAgentFrame(
      frame({ jsonrpc: '2.0', id: null, method: 'tools/call', params: { name: 'fs__read' } }),
    )

    expect(harness.toAgent).toEqual([])
    expect(harness.records.some((r) => r.reason === 'unreadable')).toBe(true)
  })
})

describe('what the pool refuses to serve', () => {
  beforeEach(() => {
    harness = createHarness(['fs'])
  })

  test.each(['resources/list', 'resources/read', 'completion/complete'])(
    '%s is method-not-found (PE3)',
    (method) => {
      harness.mux.handleAgentFrame(request(1, method))

      expect(errorOf(harness.toAgent[0] ?? {}).code).toBe(ERROR_CODE_POOL_METHOD_NOT_FOUND)
    },
  )

  test('a response FROM the agent is dropped: the pool asked it nothing', () => {
    harness.mux.handleAgentFrame(frame({ jsonrpc: '2.0', id: 1, result: {} }))

    expect(harness.toAgent).toEqual([])
    expect(harness.records.some((r) => r.reason === 'unreadable')).toBe(true)
  })

  test('garbage in never becomes an exception out', () => {
    harness.mux.handleAgentFrame(Buffer.from('not json at all', 'utf8'))

    expect(harness.errors).toEqual([])
    expect(harness.toAgent).toEqual([])
  })
})

describe('frames from a child', () => {
  beforeEach(async () => {
    harness = createHarness(['fs'])
    await listOnce(harness, { fs: ['read'] })
  })

  test('a request from a server is dropped, never shown to the agent (PE3)', () => {
    // Upstreams are told of no sampling, elicitation or roots, so this is
    // unsolicited — and the agent never offered to answer it.
    harness.servers
      .get('fs')
      ?.emit('{"jsonrpc":"2.0","id":"srv-1","method":"sampling/createMessage","params":{}}')

    expect(harness.toAgent).toEqual([])
    const dropped = harness.records.find((r) => r.reason === 'server-request')
    expect(dropped?.method).toBe('sampling/createMessage')
  })

  test("a server's own notification reaches the agent", () => {
    harness.servers
      .get('fs')
      ?.emit('{"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}')

    expect(harness.toAgent[0]?.['method']).toBe('notifications/progress')
  })
})

describe('membership changes', () => {
  beforeEach(async () => {
    harness = createHarness(['fs', 'github'])
    await listOnce(harness, { fs: ['read'], github: ['create_issue'] })
  })

  test('gives an in-flight call exactly ONE outcome when its server leaves', async () => {
    harness.mux.handleAgentFrame(request(60, 'tools/call', { name: 'fs__read', arguments: {} }))

    await harness.membership(['github'])

    const gone = harness.toAgent.filter((body) => body['id'] === 60)
    expect(gone).toHaveLength(1)
    expect(errorOf(gone[0] ?? {}).code).toBe(ERROR_CODE_POOL_MEMBER_GONE)
  })

  test('tells the agent the list changed AFTER the departing server is gone', async () => {
    // The other order would let the agent re-read the catalog while the
    // departing server was still in the table and see it one last time.
    await harness.membership(['github'])

    const methods = harness.toAgent.map((body) => body['method'])
    expect(methods).toContain('notifications/tools/list_changed')
    expect(methods).toContain('notifications/prompts/list_changed')
    harness.toAgent.length = 0
    harness.mux.handleAgentFrame(request(2, 'tools/list'))
    await answerList(harness, 'github', ['create_issue'])
    await vi.waitFor(() => expect(harness.toAgent).toHaveLength(1))
    const tools = (harness.toAgent[0]?.['result'] as { tools: { name: string }[] }).tools
    expect(tools.map((t) => t.name)).toEqual(['github__create_issue'])
  })

  test('records the new membership', async () => {
    await harness.membership(['github'])

    const changed = harness.records.find((r) => r.event === 'members-changed')
    expect(changed?.members).toEqual(['github'])
  })

  test('a newly granted server is NOT opened by the change itself (P3)', async () => {
    // PE7 stays: the watch wakes the agent, the next `tools/list` opens it.
    await harness.membership(['fs', 'github', 'db'])

    expect(harness.servers.has('db')).toBe(false)
  })
})

describe('notifications/cancelled', () => {
  beforeEach(async () => {
    harness = createHarness(['fs', 'github'])
    await listOnce(harness, { fs: ['read'], github: ['create_issue'] })
  })

  test('goes to the ONE server holding that request, not to all of them', async () => {
    // Broadcasting a cancel would stop work the agent never asked to stop —
    // in a pool, that means cancelling calls on servers it did not name.
    harness.mux.handleAgentFrame(request(50, 'tools/call', { name: 'fs__read', arguments: {} }))
    const githubBefore = harness.servers.get('github')?.seen.length ?? 0

    harness.mux.handleAgentFrame(
      frame({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 50 } }),
    )

    expect(harness.servers.get('fs')?.seen.at(-1)).toContain('notifications/cancelled')
    expect(harness.servers.get('github')?.seen).toHaveLength(githubBefore)
  })

  test('is swallowed when no server holds that id', async () => {
    // The request already settled, or never existed. Either way there is
    // nobody to tell, and guessing would cancel somebody else's work.
    const before = new Map(
      [...harness.servers].map(([name, server]) => [name, server.seen.length]),
    )

    harness.mux.handleAgentFrame(
      frame({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 } }),
    )

    for (const [name, count] of before) {
      expect(harness.servers.get(name)?.seen).toHaveLength(count)
    }
    expect(harness.toAgent).toEqual([])
  })

  test('is swallowed when it names no request at all', async () => {
    harness.mux.handleAgentFrame(
      frame({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }),
    )

    expect(harness.errors).toEqual([])
    expect(harness.toAgent).toEqual([])
  })

  test('any other notification from the agent is dropped with a record', async () => {
    harness.mux.handleAgentFrame(
      frame({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }),
    )

    const dropped = harness.records.find((r) => r.method === 'notifications/roots/list_changed')
    expect(dropped?.reason).toBe('unsupported-method')
  })
})

describe('frames the pool cannot read', () => {
  beforeEach(async () => {
    harness = createHarness(['fs'])
    await listOnce(harness, { fs: ['read'] })
  })

  test('a tools/call with no readable name is refused, not forwarded', async () => {
    // "Some server" is never the answer: an unreadable frame is answered with
    // an error, and no upstream sees it.
    const before = harness.servers.get('fs')?.seen.length ?? 0

    harness.mux.handleAgentFrame(
      frame({ jsonrpc: '2.0', id: 60, method: 'tools/call', params: { name: 42 } }),
    )

    expect(errorOf(harness.toAgent[0] ?? {}).code).toBe(ERROR_CODE_POOL_METHOD_NOT_FOUND)
    expect(harness.servers.get('fs')?.seen).toHaveLength(before)
  })

  test('an initialize with a null id is dropped: there is nowhere to answer', async () => {
    harness.mux.handleAgentFrame(frame({ jsonrpc: '2.0', id: null, method: 'initialize' }))

    expect(harness.toAgent).toEqual([])
    expect(harness.records.some((r) => r.reason === 'unreadable')).toBe(true)
  })

  test('an unreadable frame from a CHILD is dropped with a record', async () => {
    harness.servers.get('fs')?.emit('not json')

    expect(harness.toAgent).toEqual([])
    const dropped = harness.records.find(
      (r) => r.serverName === 'fs' && r.reason === 'unreadable',
    )
    expect(dropped).toBeDefined()
  })

  test('a fan-out reply arriving after its page gave up is recorded, not lost', async () => {
    // The catalog has stopped waiting, so nothing settles — but the plane
    // still wrote down that an upstream answered something nobody wanted.
    const id = (
      JSON.parse(
        (harness.servers.get('fs')?.seen ?? []).find((line) =>
          line.includes('tools/list'),
        ) as string,
      ) as { id: string }
    ).id
    harness.records.length = 0

    harness.servers.get('fs')?.emit(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } }))

    expect(
      harness.records.some((r) => r.reason === 'uncorrelated-reply'),
    ).toBe(true)
  })
})

describe('a journal that will not write', () => {
  test('never takes the traffic down with it', async () => {
    // "No audit record, no traffic" is enforced by the SINK's own fail-closed
    // path, not by letting an exception escape into the dispatch.
    const thrown: unknown[] = []
    harness = createHarness(['fs'])
    const broken = createPoolMultiplexer({
      agentName: 'bot',
      planeVersion: PLANE_VERSION,
      children: {
        servers: () => [],
        childOf: () => undefined,
        ensure: () => Promise.resolve(),
        detach: () => Promise.resolve(),
        closeAll: () => Promise.resolve(),
      },
      catalog: { build: () => Promise.resolve(null) },
      correlator: createPoolCorrelator(10),
      fanout: { ask: () => Promise.resolve(null), settle: () => false },
      watch: { granted: [], start: () => undefined, stop: () => undefined },
      journal: () => {
        throw new Error('journal is down')
      },
      toAgent: () => undefined,
      onError: (error) => thrown.push(error),
    })

    broken.handleAgentFrame(request(1, 'resources/list'))

    expect(thrown).toHaveLength(1)
  })
})

describe('framing', () => {
  test('never hands the agent a frame that still carries its newline', async () => {
    // Framing belongs to the transport. A payload with a trailing newline
    // cannot be line-framed for a stdio client at all, so a bridged agent got
    // NOTHING — the loudest failure behind the quietest symptom. Asserted over
    // frames from every synthesizer the dispatch reaches, because they do not
    // all come from this module (`proxy/synthesize.ts` appends one for the
    // stdio proxy, and must keep doing so).
    harness = createHarness(['fs'])

    // The merged catalog first (it clears the decoded log it asserts on), then
    // one frame from each remaining synthesizer.
    await listOnce(harness, { fs: ['read'] })
    harness.mux.handleAgentFrame(request(1, 'initialize'))
    harness.mux.handleAgentFrame(request(2, 'ping'))
    harness.mux.handleAgentFrame(request(3, 'resources/list'))
    harness.mux.handleAgentFrame(request(4, 'tools/list', { cursor: 'x' }))
    harness.mux.handleAgentFrame(request(5, 'tools/call', { name: 'nope__x', arguments: {} }))
    await harness.membership([])

    expect(harness.rawToAgent.length).toBeGreaterThan(5)
    for (const frame of harness.rawToAgent) {
      expect(frame.toString('utf8')).not.toContain('\n')
    }
  })
})

describe('a child that leaves outside a membership change', () => {
  // The bug both reviews of phase 3 found. Every one of these departures used
  // to leave the agent's in-flight call unanswered AND leave a correlator
  // entry keyed by the server NAME — which the next child opened for that same
  // name could then settle with anything at all.
  beforeEach(async () => {
    harness = createHarness(['fs', 'github'])
    await listOnce(harness, { fs: ['read'], github: ['create_issue'] })
  })

  test('an in-flight call gets exactly ONE answer when the child session ends', async () => {
    harness.mux.handleAgentFrame(request(70, 'tools/call', { name: 'fs__read', arguments: {} }))

    harness.servers.get('fs')?.end()
    await vi.waitFor(() => expect(harness.toAgent).toHaveLength(1))

    expect(harness.toAgent[0]?.['id']).toBe(70)
    expect(errorOf(harness.toAgent[0] ?? {}).code).toBe(ERROR_CODE_POOL_MEMBER_GONE)
  })

  test('a reopened server cannot settle an id tracked against its predecessor', async () => {
    // The forgery: a server that drops its connection after receiving a
    // sensitive call, then reconnects and answers that call itself.
    harness.mux.handleAgentFrame(request(71, 'tools/call', { name: 'fs__read', arguments: {} }))
    harness.servers.get('fs')?.end()
    await vi.waitFor(() => expect(harness.toAgent).toHaveLength(1))
    harness.toAgent.length = 0

    // The agent lists again, which opens a NEW child for the same name. Both
    // servers are asked, so both must answer or the merge waits on a timeout.
    harness.mux.handleAgentFrame(request(72, 'tools/list'))
    await Promise.all([
      answerList(harness, 'fs', ['read']),
      answerList(harness, 'github', ['create_issue']),
    ])
    await vi.waitFor(() => expect(harness.toAgent.length).toBeGreaterThan(0))
    harness.toAgent.length = 0

    // ...and that new child fabricates a result for the earlier call.
    harness.servers.get('fs')?.emit('{"jsonrpc":"2.0","id":71,"result":{"forged":true}}')

    expect(harness.toAgent).toEqual([])
    expect(harness.records.some((r) => r.reason === 'uncorrelated-reply')).toBe(true)
  })

  test("a predecessor's late frame is not read as its successor's", async () => {
    // The same substitution from the other side: the old instance speaks after
    // a new one has taken its place.
    const stale = harness.servers.get('fs')
    harness.mux.handleAgentFrame(request(73, 'tools/call', { name: 'fs__read', arguments: {} }))
    harness.servers.get('fs')?.end()
    await vi.waitFor(() => expect(harness.toAgent).toHaveLength(1))
    harness.mux.handleAgentFrame(request(74, 'tools/list'))
    await Promise.all([
      answerList(harness, 'fs', ['read']),
      answerList(harness, 'github', ['create_issue']),
    ])
    await vi.waitFor(() => expect(harness.toAgent.length).toBeGreaterThan(0))
    harness.toAgent.length = 0

    stale?.emit('{"jsonrpc":"2.0","id":73,"result":{"forged":true}}')

    expect(harness.toAgent).toEqual([])
  })

  test('releaseServer is idempotent, so several paths may call it', async () => {
    // It runs from the membership change AND from the children's own detach
    // event; a second call must not invent a second answer for one id.
    harness.mux.handleAgentFrame(request(75, 'tools/call', { name: 'fs__read', arguments: {} }))

    harness.mux.releaseServer('fs')
    harness.mux.releaseServer('fs')

    expect(harness.toAgent.filter((body) => body['id'] === 75)).toHaveLength(1)
  })
})

describe('close', () => {
  test('closes every child and ignores later frames, twice over', async () => {
    harness = createHarness(['fs'])
    await listOnce(harness, { fs: ['read'] })

    await harness.mux.close()
    await harness.mux.close()
    harness.toAgent.length = 0
    harness.mux.handleAgentFrame(request(2, 'ping'))

    expect(harness.toAgent).toEqual([])
  })
})
