import { describe, expect, test } from 'vitest'
import {
  extractPerMessageHeaders,
  INITIALIZED_NOTIFICATION,
  LATEST_SESSIONFUL_PROTOCOL_VERSION,
  PROMPTS_GET_METHOD,
  PROMPTS_LIST_CHANGED_NOTIFICATION,
  PROMPTS_LIST_METHOD,
  SESSIONFUL_PROTOCOL_VERSIONS,
  TOOLS_LIST_CHANGED_NOTIFICATION,
} from '../../src/protocol/mcp.js'

/**
 * The method names and version list the agent pool needs (ADR-0015). They live
 * in `protocol/mcp.ts` because it is the single point of coupling to the MCP
 * spec — the pool must not re-type a spec literal of its own.
 */
describe('pool-facing MCP spec constants', () => {
  test.each([
    ['prompts/list', PROMPTS_LIST_METHOD],
    ['prompts/get', PROMPTS_GET_METHOD],
    ['notifications/initialized', INITIALIZED_NOTIFICATION],
    ['notifications/tools/list_changed', TOOLS_LIST_CHANGED_NOTIFICATION],
    ['notifications/prompts/list_changed', PROMPTS_LIST_CHANGED_NOTIFICATION],
  ])('spells %s exactly as the spec does', (expected, actual) => {
    expect(actual).toBe(expected)
  })

  test('lists the sessionful revisions oldest first', () => {
    expect([...SESSIONFUL_PROTOCOL_VERSIONS]).toEqual(['2025-03-26', '2025-06-18', '2025-11-25'])
  })

  test('excludes the stateless 2026-07-28 revision, which has no initialize at all', () => {
    // The pool answers `initialize` itself (ADR-0015 §4); a revision that
    // removed the handshake cannot be negotiated through one.
    expect(SESSIONFUL_PROTOCOL_VERSIONS).not.toContain('2026-07-28')
  })

  test('the named latest revision really is the newest one in the list', () => {
    // Two declarations, one truth: this is what stops them drifting apart.
    expect(LATEST_SESSIONFUL_PROTOCOL_VERSION).toBe(
      SESSIONFUL_PROTOCOL_VERSIONS[SESSIONFUL_PROTOCOL_VERSIONS.length - 1],
    )
    expect(SESSIONFUL_PROTOCOL_VERSIONS).toContain(LATEST_SESSIONFUL_PROTOCOL_VERSION)
  })

  test('the last element is the newest, so "latest supported" is the array tail', () => {
    const sorted = [...SESSIONFUL_PROTOCOL_VERSIONS].sort()

    expect(sorted).toEqual([...SESSIONFUL_PROTOCOL_VERSIONS])
  })

  test('prompts/get still mirrors Mcp-Name after the literal became a constant', () => {
    const bytes = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: PROMPTS_GET_METHOD, params: { name: 'review' } }),
      'utf8',
    )

    const headers = extractPerMessageHeaders(bytes)

    expect(headers['Mcp-Name']).toBe('review')
    expect(headers['Mcp-Method']).toBe('prompts/get')
  })
})
