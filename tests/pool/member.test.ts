import { describe, expect, test } from 'vitest'
import type { PoolChild } from '../../src/pool/children.js'
import { PoolMemberFrameError, statelessMember } from '../../src/pool/member.js'
import { clientMessage } from '../../src/transport/message.js'

/**
 * A 2026-07-28 member: one sink that stamps every frame the pool sends it
 * (RV3) — so no path to the member can forget the `_meta` its revision needs.
 */

const CLIENT = { name: 'mcpcut-pool', version: '1.0.0' }

function childRecording(): { child: PoolChild; written: string[]; closes: number[] } {
  const written: string[] = []
  const closes: number[] = []
  const child: PoolChild = {
    server: 'modern',
    sessionId: 's-modern',
    sink: {
      write: (message) => {
        written.push(message.bytes.toString('utf8'))
        return Promise.resolve()
      },
      dispose: () => undefined,
    },
    close: () => {
      closes.push(1)
      return Promise.resolve()
    },
  }
  return { child, written, closes }
}

function frame(body: unknown) {
  return clientMessage(Buffer.from(JSON.stringify(body), 'utf8'))
}

describe('statelessMember', () => {
  test('stamps a routed call, keeping its id, name and arguments', async () => {
    // Arrange
    const { child, written } = childRecording()
    const member = statelessMember(child, CLIENT)

    // Act
    await member.sink.write(
      frame({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } }),
    )

    // Assert
    const sent = JSON.parse(written[0] as string) as {
      id: number
      params: { name: string; arguments: unknown; _meta: Record<string, unknown> }
    }
    expect(sent.id).toBe(4)
    expect(sent.params.name).toBe('echo')
    expect(sent.params.arguments).toEqual({ a: 1 })
    expect(sent.params._meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28')
  })

  test('stamps a notification too', async () => {
    const { child, written } = childRecording()

    await statelessMember(child, CLIENT).sink.write(
      frame({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4 } }),
    )

    expect(written[0]).toContain('io.modelcontextprotocol/clientCapabilities')
  })

  test('refuses to pass on a frame that is not a request or notification', async () => {
    const { child, written } = childRecording()

    await expect(
      statelessMember(child, CLIENT).sink.write(frame({ jsonrpc: '2.0', id: 1, result: {} })),
    ).rejects.toBeInstanceOf(PoolMemberFrameError)
    expect(written).toEqual([])
  })

  test('keeps the child’s own close, so its memo is not lost', () => {
    const { child } = childRecording()

    const member = statelessMember(child, CLIENT)

    expect(member.close).toBe(child.close)
    expect(member.sessionId).toBe(child.sessionId)
    expect(member.server).toBe(child.server)
  })
})
