import { describe, expect, test } from 'vitest'
import { performUpstreamHandshake } from '../../src/pool/handshake.js'
import type { PoolChild } from '../../src/pool/children.js'
import type { PoolFanout } from '../../src/pool/fanout.js'
import type { MessageSink } from '../../src/transport/message.js'

/**
 * The handshake the plane opens to one upstream of a pool (ADR-0015 §4).
 *
 * A pool address answers the AGENT's `initialize` itself (PE12), so nothing
 * the agent sends reaches an upstream — the plane has to introduce itself, or a
 * server that follows the spec refuses everything after. Every "no" here means
 * "this server did not come up", which the caller turns into a smaller pool
 * rather than a refused one (PE6).
 */

const PLANE_VERSION = '0.1.0'

interface Harness {
  readonly child: PoolChild
  /** Lines the plane wrote to the upstream, in order. */
  readonly written: string[]
  readonly asked: string[]
}

function harnessWith(answer: string | null): Harness {
  const written: string[] = []
  const asked: string[] = []
  const sink: MessageSink = {
    write: (message) => {
      written.push(message.bytes.toString('utf8'))
      return Promise.resolve()
    },
    dispose: () => undefined,
  }
  const child: PoolChild = {
    server: 'fs',
    sessionId: 's-fs',
    sink,
    close: () => Promise.resolve(),
  }
  const fanout: PoolFanout = {
    ask: async (target, tag, buildLine) => {
      asked.push(tag)
      await target.sink.write({
        bytes: Buffer.from(buildLine('plane-1'), 'utf8'),
        meta: { origin: 'client' },
      } as never)
      return answer
    },
    settle: () => false,
  }
  return {
    child,
    written,
    asked,
    // The fanout is handed back through a closure property for the tests below.
    ...({ fanout } as object),
  } as Harness & { fanout: PoolFanout }
}

function result(protocolVersion: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 'plane-1',
    result: {
      protocolVersion,
      capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: 'fs', version: '1' },
    },
  })
}

function run(answer: string | null): {
  readonly outcome: Promise<unknown>
  readonly harness: Harness & { fanout: PoolFanout }
} {
  const harness = harnessWith(answer) as Harness & { fanout: PoolFanout }
  return {
    harness,
    outcome: performUpstreamHandshake(harness.fanout, harness.child, PLANE_VERSION),
  }
}

describe('performUpstreamHandshake', () => {
  test('declares NO client capabilities, so no server will initiate one (PE3)', async () => {
    // Load-bearing, not tidiness: a server told of no sampling, elicitation or
    // roots will not ask the agent anything.
    const { harness, outcome } = run(result('2025-11-25'))
    await outcome

    const sent = JSON.parse(harness.written[0] as string) as {
      method: string
      params: { capabilities: Record<string, unknown>; clientInfo: { version: string } }
    }
    expect(sent.method).toBe('initialize')
    expect(sent.params.capabilities).toEqual({})
    expect(sent.params.clientInfo.version).toBe(PLANE_VERSION)
  })

  test('closes the handshake with the initialized notification', async () => {
    const { harness, outcome } = run(result('2025-11-25'))

    await expect(outcome).resolves.toMatchObject({ protocolVersion: '2025-11-25' })
    expect(harness.written[1]).toContain('notifications/initialized')
  })

  test('reports the capabilities the upstream declared', async () => {
    const { outcome } = run(result('2025-06-18'))

    await expect(outcome).resolves.toEqual({
      protocolVersion: '2025-06-18',
      hasTools: true,
      hasPrompts: true,
    })
  })

  test('a server that never answered did not come up (PE6)', async () => {
    const { harness, outcome } = run(null)

    await expect(outcome).resolves.toBeNull()
    // And the plane did not go on to greet a server that never replied.
    expect(harness.written).toHaveLength(1)
  })

  test('a revision the plane cannot negotiate means the server did not come up', async () => {
    // 2026-07-28 REMOVED the handshake, so a server answering one with it is
    // self-contradictory: the plane cannot tell which discipline applies, and
    // opening the pool without it is the fail-closed direction.
    const { harness, outcome } = run(result('2026-07-28'))

    await expect(outcome).resolves.toBeNull()
    expect(harness.written).toHaveLength(1)
  })

  test('an error response means the server did not come up', async () => {
    const { outcome } = run(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'plane-1',
        error: { code: -32603, message: 'no' },
      }),
    )

    await expect(outcome).resolves.toBeNull()
  })

  test('garbage means the server did not come up', async () => {
    const { outcome } = run('not json at all')

    await expect(outcome).resolves.toBeNull()
  })
})
