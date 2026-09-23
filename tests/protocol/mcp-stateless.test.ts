import { describe, expect, test } from 'vitest'
import { extractPerMessageHeaders } from '../../src/protocol/mcp.js'
import {
  META_CLIENT_CAPABILITIES_KEY,
  META_CLIENT_INFO_KEY,
  META_PROTOCOL_VERSION_KEY,
  STATELESS_PROTOCOL_VERSION,
  withStatelessMeta,
} from '../../src/protocol/mcp-stateless.js'

/**
 * The `_meta` every request to a 2026-07-28 server MUST carry (RV3). The pool
 * speaks to such a member in the plane's own name, so the three keys are the
 * plane's — whatever the agent put there — and everything else is kept.
 */

const CLIENT = { name: 'mcpcut-pool', version: '9.9.9' }

function stamp(body: unknown): Record<string, unknown> | null {
  const stamped = withStatelessMeta(JSON.stringify(body), CLIENT)
  return stamped === null ? null : (JSON.parse(stamped) as Record<string, unknown>)
}

function metaOf(body: Record<string, unknown> | null): Record<string, unknown> {
  const params = body?.['params'] as { _meta?: Record<string, unknown> } | undefined
  return params?._meta ?? {}
}

describe('withStatelessMeta', () => {
  test('adds the three keys and keeps the agent’s progress token', () => {
    // Arrange / Act
    const stamped = stamp({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hi' }, _meta: { progressToken: 'p-1' } },
    })

    // Assert
    expect(metaOf(stamped)).toEqual({
      progressToken: 'p-1',
      [META_PROTOCOL_VERSION_KEY]: STATELESS_PROTOCOL_VERSION,
      [META_CLIENT_CAPABILITIES_KEY]: {},
      [META_CLIENT_INFO_KEY]: CLIENT,
    })
  })

  test('overwrites a protocol version the agent supplied', () => {
    // Arrange / Act
    const stamped = stamp({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { [META_PROTOCOL_VERSION_KEY]: '1999-01-01', [META_CLIENT_CAPABILITIES_KEY]: { sampling: {} } } },
    })

    // Assert
    expect(metaOf(stamped)[META_PROTOCOL_VERSION_KEY]).toBe(STATELESS_PROTOCOL_VERSION)
    expect(metaOf(stamped)[META_CLIENT_CAPABILITIES_KEY]).toEqual({})
  })

  test('keeps unknown fields of the frame and of params', () => {
    // Arrange / Act
    const stamped = stamp({
      jsonrpc: '2.0',
      id: 'x',
      method: 'tools/call',
      extra: true,
      params: { name: 'echo', arguments: { a: 1 }, other: [1, 2] },
    })

    // Assert
    expect(stamped).toMatchObject({ jsonrpc: '2.0', id: 'x', method: 'tools/call', extra: true })
    expect(stamped?.['params']).toMatchObject({ name: 'echo', arguments: { a: 1 }, other: [1, 2] })
  })

  test('gives a notification without params a `params._meta` of its own', () => {
    // Arrange / Act
    const stamped = stamp({ jsonrpc: '2.0', method: 'notifications/cancelled' })

    // Assert
    expect(metaOf(stamped)[META_PROTOCOL_VERSION_KEY]).toBe(STATELESS_PROTOCOL_VERSION)
  })

  test('replaces params or `_meta` that are not objects', () => {
    // Arrange / Act
    const withArrayParams = stamp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: [1] })
    const withStringMeta = stamp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: 'x' } })

    // Assert
    expect(metaOf(withArrayParams)[META_PROTOCOL_VERSION_KEY]).toBe(STATELESS_PROTOCOL_VERSION)
    expect(metaOf(withStringMeta)[META_PROTOCOL_VERSION_KEY]).toBe(STATELESS_PROTOCOL_VERSION)
  })

  test('refuses a response and garbage', () => {
    expect(withStatelessMeta(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), CLIENT)).toBeNull()
    expect(withStatelessMeta('not json', CLIENT)).toBeNull()
    expect(withStatelessMeta('[1,2]', CLIENT)).toBeNull()
    expect(withStatelessMeta(JSON.stringify({ method: 7 }), CLIENT)).toBeNull()
  })

  test('the HTTP header mirrored from the stamped body is the new revision', () => {
    // Arrange
    const stamped = withStatelessMeta(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      CLIENT,
    ) as string

    // Act
    const headers = extractPerMessageHeaders(Buffer.from(stamped, 'utf8'))

    // Assert
    expect(headers['MCP-Protocol-Version']).toBe('2026-07-28')
    expect(headers['Mcp-Method']).toBe('tools/list')
  })
})
