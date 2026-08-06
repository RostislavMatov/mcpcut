import { describe, expect, test } from 'vitest'
import { classify } from '../../src/protocol/classify.js'
import {
  detectInitializeBytes,
  extractPerMessageHeaders,
  isInitializeRequest,
} from '../../src/protocol/mcp.js'

/**
 * M3 version helpers in `protocol/mcp.ts` — the injected spec knowledge the
 * HTTP transport consumes (session-model detection, SEP-2243 per-message
 * headers). The M2 exports are pinned by `mcp.test.ts`, untouched.
 */

function bytesOf(body: unknown): Buffer {
  return Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
}

describe('isInitializeRequest', () => {
  test('true for an initialize request', () => {
    const msg = classify(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }))
    expect(isInitializeRequest(msg)).toBe(true)
  })

  test.each([
    ['another request method', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
    ['an initialize-shaped notification (no id)', { jsonrpc: '2.0', method: 'initialize' }],
    ['a response', { jsonrpc: '2.0', id: 1, result: {} }],
    ['garbage', 'not json'],
  ])('false for %s', (_label, body) => {
    const msg = classify(typeof body === 'string' ? body : JSON.stringify(body))
    expect(isInitializeRequest(msg)).toBe(false)
  })
})

describe('detectInitializeBytes', () => {
  test('true for a request-shaped initialize body', () => {
    expect(detectInitializeBytes(bytesOf({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }))).toBe(true)
  })

  test.each([
    ['an id-less initialize', { jsonrpc: '2.0', method: 'initialize' }],
    ['another method', { jsonrpc: '2.0', id: 1, method: 'tools/call' }],
    ['a top-level array', [{ method: 'initialize', id: 1 }]],
    ['a non-object', 42],
    ['unparseable bytes', '{ nope'],
  ])('false for %s — never throws', (_label, body) => {
    expect(detectInitializeBytes(bytesOf(body))).toBe(false)
  })
})

describe('extractPerMessageHeaders', () => {
  test('mirrors Mcp-Method and Mcp-Name from a tools/call body', () => {
    const headers = extractPerMessageHeaders(
      bytesOf({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: {} } }),
    )
    expect(headers).toEqual({ 'Mcp-Method': 'tools/call', 'Mcp-Name': 'read_file' })
  })

  test('mirrors params.name for prompts/get and params.uri for resources/read', () => {
    expect(
      extractPerMessageHeaders(bytesOf({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'p1' } })),
    ).toEqual({ 'Mcp-Method': 'prompts/get', 'Mcp-Name': 'p1' })
    expect(
      extractPerMessageHeaders(
        bytesOf({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'file:///x' } }),
      ),
    ).toEqual({ 'Mcp-Method': 'resources/read', 'Mcp-Name': 'file:///x' })
  })

  test('other methods (and notifications) carry only Mcp-Method', () => {
    expect(extractPerMessageHeaders(bytesOf({ jsonrpc: '2.0', id: 3, method: 'tools/list' }))).toEqual({
      'Mcp-Method': 'tools/list',
    })
    expect(
      extractPerMessageHeaders(bytesOf({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })),
    ).toEqual({ 'Mcp-Method': 'notifications/progress' })
  })

  test('mirrors MCP-Protocol-Version from params._meta when the body carries one', () => {
    const headers = extractPerMessageHeaders(
      bytesOf({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'read_file',
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
        },
      }),
    )
    expect(headers['MCP-Protocol-Version']).toBe('2026-07-28')
  })

  test('a non-ASCII name is wrapped in the Base64 sentinel', () => {
    const name = 'инструмент'
    const headers = extractPerMessageHeaders(
      bytesOf({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name } }),
    )
    const expected = `=?base64?${Buffer.from(name, 'utf8').toString('base64')}?=`
    expect(headers['Mcp-Name']).toBe(expected)
    expect(headers['Mcp-Method']).toBe('tools/call')
  })

  test.each([
    ['a response body (no method)', { jsonrpc: '2.0', id: 1, result: {} }],
    ['a non-string method', { jsonrpc: '2.0', id: 1, method: 42 }],
    ['an empty method', { jsonrpc: '2.0', id: 1, method: '' }],
    ['a top-level array', []],
    ['unparseable bytes', '{ nope'],
  ])('%s yields no headers — never throws', (_label, body) => {
    expect(extractPerMessageHeaders(bytesOf(body))).toEqual({})
  })

  test('a tools/call with a malformed params shape still gets Mcp-Method, but no Mcp-Name', () => {
    expect(extractPerMessageHeaders(bytesOf({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: [] }))).toEqual({
      'Mcp-Method': 'tools/call',
    })
    expect(
      extractPerMessageHeaders(bytesOf({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 7 } })),
    ).toEqual({ 'Mcp-Method': 'tools/call' })
  })
})
