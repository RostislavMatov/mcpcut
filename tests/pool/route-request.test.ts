import { describe, expect, test } from 'vitest'
import { ERROR_CODE_UNKNOWN_POOL_TARGET } from '../../src/pool/constants.js'
import { routePoolRequest, unknownTargetError } from '../../src/pool/route-request.js'
import { extractPerMessageHeaders } from '../../src/protocol/mcp.js'

function callLine(method: string, params: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 9, method, params, ...extra })
}

function inPool(...servers: string[]): (server: string) => boolean {
  return (server) => servers.includes(server)
}

function parsedError(bytes: Buffer): { code: number; message: string } {
  const parsed = JSON.parse(bytes.toString('utf8')) as { error: { code: number; message: string } }
  return parsed.error
}

describe('routePoolRequest', () => {
  test('strips the prefix from a tools/call and names the server', () => {
    const raw = callLine('tools/call', { name: 'github__create_issue', arguments: { title: 'x' } })

    const outcome = routePoolRequest(raw, inPool('github'))

    expect(outcome).toMatchObject({ kind: 'routed', server: 'github', name: 'create_issue' })
  })

  test('strips the prefix from a prompts/get too', () => {
    const raw = callLine('prompts/get', { name: 'docs__review' })

    const outcome = routePoolRequest(raw, inPool('docs'))

    expect(outcome).toMatchObject({ kind: 'routed', server: 'docs', name: 'review' })
  })

  test('changes params.name and nothing else at all', () => {
    const raw = callLine(
      'tools/call',
      {
        name: 'github__create_issue',
        arguments: { title: 'x', nested: { deep: [1, 2, 3] } },
        _meta: { progressToken: 'tok-1' },
        'x-vendor': 'keep',
      },
      { 'x-top-level': 'keep-too' },
    )

    const outcome = routePoolRequest(raw, inPool('github'))

    expect(outcome!.kind).toBe('routed')
    const before = JSON.parse(raw) as { params: Record<string, unknown> }
    const after = JSON.parse((outcome as { serialized: string }).serialized) as {
      params: Record<string, unknown>
    }
    expect({ ...after, params: { ...after.params, name: 'github__create_issue' } }).toEqual(before)
    expect(after.params['_meta']).toEqual({ progressToken: 'tok-1' })
  })

  test('the rewritten bytes mirror the BARE name into Mcp-Name (ADR-0015 §2)', () => {
    const raw = callLine('tools/call', { name: 'github__create_issue', arguments: {} })

    const outcome = routePoolRequest(raw, inPool('github'))

    const headers = extractPerMessageHeaders(
      Buffer.from((outcome as { serialized: string }).serialized, 'utf8'),
    )
    expect(headers['Mcp-Name']).toBe('create_issue')
  })

  test.each([
    ['a name with no separator', 'create_issue'],
    ['a server that is not in this pool', 'other__create_issue'],
    ['an empty server half', '__create_issue'],
    ['an empty tool half', 'github__'],
  ])('reports %s as an unknown target', (_label, name) => {
    const outcome = routePoolRequest(callLine('tools/call', { name }), inPool('github'))

    expect(outcome).toEqual({ kind: 'unknown-target', poolName: name })
  })

  test('tells an outsider server apart from a nonexistent one in no way at all', () => {
    const absent = routePoolRequest(callLine('tools/call', { name: 'nosuch__x' }), inPool('github'))
    const outside = routePoolRequest(callLine('tools/call', { name: 'noseparator' }), inPool('github'))

    const first = unknownTargetError(1, (absent as { poolName: string }).poolName)
    const second = unknownTargetError(1, (outside as { poolName: string }).poolName)
    // Different names, but the same error shape and the same code: the agent
    // learns nothing about what exists outside its pool.
    expect(parsedError(first).code).toBe(parsedError(second).code)
    expect(parsedError(first).message.startsWith('Unknown tool: ')).toBe(true)
    expect(parsedError(second).message.startsWith('Unknown tool: ')).toBe(true)
  })

  test.each([
    ['tools/list', 'tools/list'],
    ['prompts/list', 'prompts/list'],
    ['ping', 'ping'],
    ['initialize', 'initialize'],
  ])('leaves %s alone: it carries no pool name', (_label, method) => {
    expect(routePoolRequest(callLine(method, {}), inPool('github'))).toEqual({ kind: 'not-addressed' })
  })

  test.each([
    ['unparseable JSON', '{not json'],
    ['a top-level array', '[1,2]'],
    ['params that are not an object', callLine('tools/call', 'nope')],
    ['params with no name', callLine('tools/call', { arguments: {} })],
    ['a name that is not a string', callLine('tools/call', { name: 42 })],
    ['a message with no method', JSON.stringify({ jsonrpc: '2.0', id: 1, params: { name: 'a__b' } })],
  ])('refuses %s rather than forwarding it anywhere', (_label, raw) => {
    expect(routePoolRequest(raw, inPool('github'))).toBeNull()
  })
})

describe('unknownTargetError', () => {
  test('uses the spec code for an unknown tool name', () => {
    expect(parsedError(unknownTargetError(1, 'a__b')).code).toBe(ERROR_CODE_UNKNOWN_POOL_TARGET)
  })

  test('ends with a newline, ready to write to the client', () => {
    expect(unknownTargetError(1, 'a__b').toString('utf8').endsWith('}\n')).toBe(true)
  })

  test('strips control characters out of a server-controlled name', () => {
    const error = parsedError(unknownTargetError(1, 'a__b\u0000c\u001bd\u007fe'))

    expect(error.message).toBe('Unknown tool: a__bcde')
  })

  test('strips bidi overrides and zero-width characters too', () => {
    // The name is agent-supplied and this text is read by a human in the
    // journal or the console; a right-to-left override would let it read as
    // something other than what was actually asked for.
    const error = parsedError(unknownTargetError(1, 'a__\u202edrop\u202c\u200bme\ufeff'))

    expect(error.message).toBe('Unknown tool: a__dropme')
  })

  test('truncates a very long name instead of echoing it whole', () => {
    const error = parsedError(unknownTargetError(1, 'x'.repeat(500)))

    expect(error.message.length).toBeLessThanOrEqual('Unknown tool: '.length + 128)
  })

  test('carries the same facts machine-readably', () => {
    const parsed = JSON.parse(unknownTargetError('id-1', 'a__b').toString('utf8')) as {
      id: string
      error: { data: Record<string, unknown> }
    }

    expect(parsed.id).toBe('id-1')
    expect(parsed.error.data).toEqual({ reason: 'unknown_pool_target', toolName: 'a__b' })
  })
})
