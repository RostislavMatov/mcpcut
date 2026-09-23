import { describe, expect, test, vi } from 'vitest'
import { createPoolCatalog } from '../../src/pool/catalog.js'
import { createPoolCorrelator } from '../../src/pool/correlator.js'
import { createPoolFanout } from '../../src/pool/fanout.js'
import { MAX_POOL_PENDING_REQUESTS } from '../../src/pool/constants.js'
import type { PoolChild, PoolChildren } from '../../src/pool/children.js'
import type { MessageSink } from '../../src/transport/message.js'

/**
 * Fan-out of one list request across every live child, and the merge of what
 * came back (ADR-0015 §7).
 *
 * The shape of every failure here is the same: a server that did not answer
 * contributes nothing and the agent still gets a list. Refusing the whole pool
 * because one upstream is slow would hand a hostile — or merely overloaded —
 * server a way to blind the agent to every other server it was granted.
 */

interface FakeServer {
  /** The list request lines this server received, in order. */
  readonly seen: string[]
}

interface Harness {
  readonly catalog: ReturnType<typeof createPoolCatalog>
  readonly servers: Map<string, FakeServer>
  readonly detached: { server: string; reason: string }[]
  readonly timedOut: string[]
  /** Waits for the named server's next request, then answers it as an upstream would. */
  answer(server: string, page: { entries: unknown[]; nextCursor?: string }): Promise<void>
  answerRaw(server: string, raw: string): Promise<void>
  /** The plane-minted id of the request the named server is holding. */
  openId(server: string): string
  settle(server: string, id: string, raw: string): boolean
}

function build(
  names: readonly string[],
  overrides: { timeoutMs?: number; maxPages?: number; maxPending?: number } = {},
): Harness {
  const servers = new Map<string, FakeServer>()
  const detached: { server: string; reason: string }[] = []
  const timedOut: string[] = []
  const live = new Map<string, PoolChild>()

  for (const name of names) {
    const seen: string[] = []
    servers.set(name, { seen })
    const sink: MessageSink = {
      write: (message) => {
        seen.push(message.bytes.toString('utf8'))
        return Promise.resolve()
      },
      dispose: () => undefined,
    }
    live.set(name, { server: name, sessionId: `s-${name}`, sink, close: () => Promise.resolve() })
  }

  const children: PoolChildren = {
    servers: () => [...live.keys()].sort(),
    childOf: (server) => live.get(server),
    ensure: () => Promise.resolve(),
    detach: (server, reason) => {
      detached.push({ server, reason })
      live.delete(server)
      return Promise.resolve()
    },
    closeAll: () => Promise.resolve(),
  }

  const fanout = createPoolFanout({
    correlator: createPoolCorrelator(overrides.maxPending ?? MAX_POOL_PENDING_REQUESTS),
    // Generous by default: a timeout shorter than `vi.waitFor`'s polling
    // interval would fire before any test could answer, and every assertion
    // about merging would then be an assertion about the timeout instead.
    timeoutMs: overrides.timeoutMs ?? 5_000,
    onTimeout: (server) => {
      timedOut.push(server)
      void children.detach(server, 'fanout-timeout')
    },
  })
  const catalog = createPoolCatalog({ fanout, children, maxPages: overrides.maxPages ?? 50 })

  const openId = (server: string): string => {
    const last = servers.get(server)?.seen.at(-1)
    return (JSON.parse(last ?? '{}') as { id: string }).id
  }

  /**
   * Requests already answered per server. Counted rather than measured from
   * `seen`: by the time a test calls `answer`, the request it is answering has
   * usually already been written, so "wait for one MORE line" would wait for a
   * request nobody is going to send.
   */
  const answered = new Map<string, number>()

  const awaitRequest = async (server: string): Promise<void> => {
    const soFar = answered.get(server) ?? 0
    await vi.waitFor(() => expect(servers.get(server)?.seen.length ?? 0).toBeGreaterThan(soFar))
    answered.set(server, soFar + 1)
  }

  return {
    catalog,
    servers,
    detached,
    timedOut,
    openId,
    settle: fanout.settle,
    answerRaw: async (server, raw) => {
      await awaitRequest(server)
      fanout.settle(server, openId(server), raw)
    },
    answer: async (server, page) => {
      await awaitRequest(server)
      const result: Record<string, unknown> = { tools: page.entries }
      if (page.nextCursor !== undefined) result['nextCursor'] = page.nextCursor
      const id = openId(server)
      fanout.settle(server, id, JSON.stringify({ jsonrpc: '2.0', id, result }))
    },
  }
}

function tool(name: string): Record<string, unknown> {
  return { name, description: `does ${name}`, inputSchema: { type: 'object' } }
}

/** Pulls the tool names out of a merged list frame. */
function namesIn(serialized: string): string[] {
  const parsed = JSON.parse(serialized) as { result: { tools: { name: string }[] } }
  return parsed.result.tools.map((entry) => entry.name)
}

describe('build', () => {
  test('merges one page from each server, servers in alphabetical order', async () => {
    // Arrange
    const harness = build(['github', 'fs'])

    // Act
    const built = harness.catalog.build(1, 'tools')
    await Promise.all([
      harness.answer('fs', { entries: [tool('read')] }),
      harness.answer('github', { entries: [tool('create_issue')] }),
    ])
    const merged = await built

    // Assert — alphabetical by server, so two connections of one agent see
    // byte-identical catalogs (the spec's "MUST NOT vary per-connection").
    expect(namesIn(merged?.serialized ?? '')).toEqual(['fs__read', 'github__create_issue'])
  })

  test('drains every page of one upstream before merging', async () => {
    const harness = build(['fs'])

    const built = harness.catalog.build(1, 'tools')
    await harness.answer('fs', { entries: [tool('a')], nextCursor: 'p2' })
    await harness.answer('fs', { entries: [tool('b')], nextCursor: 'p3' })
    await harness.answer('fs', { entries: [tool('c')] })

    expect(namesIn((await built)?.serialized ?? '')).toEqual(['fs__a', 'fs__b', 'fs__c'])
  })

  test('sends the cursor the previous page handed back, and none on the first', async () => {
    // An upstream is entitled to treat a cursor it never issued as an error,
    // so the first request must carry none at all.
    const harness = build(['fs'])

    const built = harness.catalog.build(1, 'tools')
    await harness.answer('fs', { entries: [tool('a')], nextCursor: 'page-2' })
    expect(harness.servers.get('fs')?.seen[0]).not.toContain('cursor')
    await harness.answer('fs', { entries: [] })

    expect(harness.servers.get('fs')?.seen[1]).toContain('"cursor":"page-2"')
    await built
  })

  test('stops at the page ceiling instead of following a cursor loop', async () => {
    const harness = build(['fs'], { maxPages: 3 })

    const built = harness.catalog.build(1, 'tools')
    for (let page = 1; page <= 3; page += 1) {
      await harness.answer('fs', { entries: [tool(`t${page}`)], nextCursor: 'always-more' })
    }
    const merged = await built

    // Three pages were read and a fourth was never requested.
    expect(harness.servers.get('fs')?.seen).toHaveLength(3)
    expect(namesIn(merged?.serialized ?? '')).toEqual(['fs__t1', 'fs__t2', 'fs__t3'])
  })

  test('a silent server is detached and simply absent from the list', async () => {
    // P4: leaving the request hanging would pile correlation entries up
    // against the cap; detaching frees them and gives the agent an honest
    // reason to read the list again.
    const harness = build(['fs', 'slow'], { timeoutMs: 20 })

    const built = harness.catalog.build(1, 'tools')
    await harness.answer('fs', { entries: [tool('read')] })
    const merged = await built

    expect(namesIn(merged?.serialized ?? '')).toEqual(['fs__read'])
    expect(harness.timedOut).toEqual(['slow'])
    expect(harness.detached).toContainEqual({ server: 'slow', reason: 'fanout-timeout' })
  })

  test('an error response from one server leaves the others intact', async () => {
    const harness = build(['broken', 'fs'])

    const built = harness.catalog.build(1, 'tools')
    await Promise.all([
      harness.answerRaw('broken', '{"jsonrpc":"2.0","id":"x","error":{"code":-32603,"message":"boom"}}'),
      harness.answer('fs', { entries: [tool('read')] }),
    ])

    expect(namesIn((await built)?.serialized ?? '')).toEqual(['fs__read'])
  })

  test('an empty pool answers an empty list, not an error', async () => {
    // An agent with no grants is a legal state, not a fault.
    const harness = build([])

    const merged = await harness.catalog.build(1, 'tools')

    expect(namesIn(merged?.serialized ?? '')).toEqual([])
  })

  test('merges prompts the same way when asked for prompts', async () => {
    const harness = build(['fs'])

    const built = harness.catalog.build(1, 'prompts')
    await vi.waitFor(() => expect(harness.servers.get('fs')?.seen).toHaveLength(1))
    expect(harness.servers.get('fs')?.seen[0]).toContain('prompts/list')
    const id = harness.openId('fs')
    harness.settle(
      'fs',
      id,
      JSON.stringify({ jsonrpc: '2.0', id, result: { prompts: [{ name: 'summarize' }] } }),
    )
    const merged = await built

    const parsed = JSON.parse(merged?.serialized ?? '{}') as {
      result: { prompts: { name: string }[] }
    }
    expect(parsed.result.prompts.map((p) => p.name)).toEqual(['fs__summarize'])
  })

  test('reports the names it hid and warned about', async () => {
    const harness = build(['fs'])

    const built = harness.catalog.build(1, 'tools')
    await harness.answer('fs', { entries: [tool('x'.repeat(70)), tool('y'.repeat(50))] })
    const merged = await built

    expect(merged?.hidden).toHaveLength(1)
    expect(merged?.warned).toHaveLength(1)
  })

  test('a server whose correlation budget is exhausted is simply absent', async () => {
    // `trackFanout` returning null is "this server did not answer", not an
    // exception — the other servers still get listed.
    const harness = build(['fs'], { maxPending: 0 })

    const merged = await harness.catalog.build(1, 'tools')

    expect(namesIn(merged?.serialized ?? '')).toEqual([])
  })
})
