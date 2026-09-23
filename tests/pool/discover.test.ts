import { describe, expect, test } from 'vitest'
import { buildServerDiscover, readServerDiscoverResult } from '../../src/pool/discover.js'

/**
 * `server/discover`: what the plane asks a server that did not take its
 * handshake (RV2). A reply that names 2026-07-28 among the versions it speaks
 * makes a stateless member; anything else is a server the plane cannot use.
 */

function discoverResult(result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 'mcpcut-pool:1', result })
}

describe('buildServerDiscover', () => {
  test('is a request carrying only the stamped `_meta`', () => {
    // Act
    const line = buildServerDiscover('mcpcut-pool:1', '1.2.3')

    // Assert
    const parsed = JSON.parse(line) as {
      id: string
      method: string
      params: { _meta: Record<string, unknown> }
    }
    expect(parsed.id).toBe('mcpcut-pool:1')
    expect(parsed.method).toBe('server/discover')
    expect(Object.keys(parsed.params)).toEqual(['_meta'])
    expect(parsed.params._meta).toEqual({
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'mcpcut-pool', version: '1.2.3' },
    })
    expect(line).not.toContain('\n')
  })
})

describe('readServerDiscoverResult', () => {
  test('a server that speaks 2026-07-28 is a stateless member, with its catalogs', () => {
    const raw = discoverResult({
      supportedVersions: ['2025-11-25', '2026-07-28'],
      capabilities: { tools: {}, prompts: { listChanged: true } },
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'public',
    })

    expect(readServerDiscoverResult(raw)).toEqual({ hasTools: true, hasPrompts: true })
  })

  test('a capability that is not an object does not count', () => {
    const raw = discoverResult({ supportedVersions: ['2026-07-28'], capabilities: { tools: true } })

    expect(readServerDiscoverResult(raw)).toEqual({ hasTools: false, hasPrompts: false })
  })

  test.each([
    ['no supportedVersions', { capabilities: {} }],
    ['supportedVersions without 2026-07-28', { supportedVersions: ['2027-01-01'], capabilities: {} }],
    ['supportedVersions that is not an array', { supportedVersions: '2026-07-28', capabilities: {} }],
    ['capabilities that is not an object', { supportedVersions: ['2026-07-28'], capabilities: [] }],
    ['no capabilities at all', { supportedVersions: ['2026-07-28'] }],
  ])('refuses %s (fail-closed)', (_label, result) => {
    expect(readServerDiscoverResult(discoverResult(result))).toBeNull()
  })

  test('refuses an error response and garbage', () => {
    expect(
      readServerDiscoverResult(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } })),
    ).toBeNull()
    expect(readServerDiscoverResult('{nope')).toBeNull()
  })

  test('reads a huge version list without choking', () => {
    const versions = Array.from({ length: 100_000 }, (_, index) => `v-${index}`)
    const raw = discoverResult({ supportedVersions: [...versions, '2026-07-28'], capabilities: {} })

    expect(readServerDiscoverResult(raw)).toEqual({ hasTools: false, hasPrompts: false })
  })
})
