import { describe, expect, test } from 'vitest'
import { classify } from '../../src/protocol/classify.js'
import {
  isToolsListRequest,
  parseToolCall,
  parseToolsListResult,
  serializeToolsListResult,
} from '../../src/protocol/mcp.js'

describe('parseToolCall', () => {
  test('parses a valid tools/call request', () => {
    const line =
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"delete_file","arguments":{"path":"/tmp/a"}}}'

    const result = parseToolCall(classify(line))

    expect(result).toEqual({
      toolName: 'delete_file',
      args: { path: '/tmp/a' },
      id: 1,
    })
  })

  test('returns null when params is missing', () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"tools/call"}'

    expect(parseToolCall(classify(line))).toBeNull()
  })

  test('returns null when params.name is not a string', () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":123}}'

    expect(parseToolCall(classify(line))).toBeNull()
  })

  test('returns null when params.name is an empty string', () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":""}}'

    expect(parseToolCall(classify(line))).toBeNull()
  })

  test('returns args: null when arguments is missing', () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_files"}}'

    const result = parseToolCall(classify(line))

    expect(result).toEqual({ toolName: 'list_files', args: null, id: 1 })
  })

  test('returns null for a tools/call notification (requests only)', () => {
    // NOTE: a `tools/call` notification (no id) is a spec violation — there
    // is nowhere to send a response. parseToolCall only handles requests;
    // the caller (proxy/gate.ts) is expected to forward notifications
    // unconditionally without consulting this parser.
    const line = '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_files"}}'

    expect(parseToolCall(classify(line))).toBeNull()
  })

  test('returns null for a non tools/call request', () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"ping"}'

    expect(parseToolCall(classify(line))).toBeNull()
  })

  test('returns null for a response', () => {
    const line = '{"jsonrpc":"2.0","id":1,"result":{}}'

    expect(parseToolCall(classify(line))).toBeNull()
  })

  test('returns null for invalid JSON-RPC input', () => {
    expect(parseToolCall(classify('not json'))).toBeNull()
  })

  test('preserves id: 0 (falsy id must not be lost)', () => {
    const line = '{"jsonrpc":"2.0","id":0,"method":"tools/call","params":{"name":"ping"}}'

    const result = parseToolCall(classify(line))

    expect(result?.id).toBe(0)
  })

  test('preserves a string id', () => {
    const line =
      '{"jsonrpc":"2.0","id":"req-abc","method":"tools/call","params":{"name":"ping"}}'

    const result = parseToolCall(classify(line))

    expect(result?.id).toBe('req-abc')
  })

  test('never throws on malformed input', () => {
    expect(() => parseToolCall(classify('{"unterminated'))).not.toThrow()
  })
})

describe('isToolsListRequest', () => {
  test('returns true for a tools/list request', () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

    expect(isToolsListRequest(classify(line))).toBe(true)
  })

  test('returns false for a different method', () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"tools/call"}'

    expect(isToolsListRequest(classify(line))).toBe(false)
  })

  test('returns false for a tools/list notification (no id)', () => {
    const line = '{"jsonrpc":"2.0","method":"tools/list"}'

    expect(isToolsListRequest(classify(line))).toBe(false)
  })

  test('returns false for a response', () => {
    const line = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'

    expect(isToolsListRequest(classify(line))).toBe(false)
  })

  test('returns false for invalid input', () => {
    expect(isToolsListRequest(classify('garbage'))).toBe(false)
  })
})

describe('parseToolsListResult', () => {
  test('parses a valid tools/list result including nextCursor and annotations', () => {
    const line =
      '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"read_file","description":"reads a file","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true,"vendorExtra":"x"}}],"nextCursor":"page-2"}}'

    const result = parseToolsListResult(classify(line))

    expect(result).toEqual({
      tools: [
        {
          name: 'read_file',
          description: 'reads a file',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true, vendorExtra: 'x' },
        },
      ],
      nextCursor: 'page-2',
    })
  })

  test('parses a valid tools/list result without nextCursor or annotations', () => {
    const line = '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"ping"}]}}'

    const result = parseToolsListResult(classify(line))

    expect(result).toEqual({ tools: [{ name: 'ping' }] })
    expect(result && 'nextCursor' in result).toBe(false)
  })

  test('returns null when result.tools is not an array', () => {
    const line = '{"jsonrpc":"2.0","id":1,"result":{"tools":"not-an-array"}}'

    expect(parseToolsListResult(classify(line))).toBeNull()
  })

  test('returns null when result.tools is missing', () => {
    const line = '{"jsonrpc":"2.0","id":1,"result":{}}'

    expect(parseToolsListResult(classify(line))).toBeNull()
  })

  test('skips malformed entries (non-object, missing/non-string name) without failing the whole parse', () => {
    const line =
      '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"ok"},"not-an-object",{"noName":true},{"name":123},{"name":"also-ok"}]}}'

    const result = parseToolsListResult(classify(line))

    expect(result).toEqual({ tools: [{ name: 'ok' }, { name: 'also-ok' }] })
  })

  test('ignores a non-string nextCursor', () => {
    const line = '{"jsonrpc":"2.0","id":1,"result":{"tools":[],"nextCursor":123}}'

    const result = parseToolsListResult(classify(line))

    expect(result).toEqual({ tools: [] })
  })

  test('returns null for an error response', () => {
    const line = '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"nope"}}'

    expect(parseToolsListResult(classify(line))).toBeNull()
  })

  test('returns null for a request', () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

    expect(parseToolsListResult(classify(line))).toBeNull()
  })

  test('returns null for invalid input', () => {
    expect(parseToolsListResult(classify('not json'))).toBeNull()
  })

  test('never throws on malformed input', () => {
    expect(() => parseToolsListResult(classify('{"unterminated'))).not.toThrow()
  })
})

describe('serializeToolsListResult', () => {
  test('round-trips: preserves nextCursor and unknown fields, replaces tools, single line', () => {
    const line =
      '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"old_tool"}],"nextCursor":"page-2","_meta":{"vendor":"x"}},"_meta":{"top":"y"}}'
    const original = classify(line)

    const serialized = serializeToolsListResult(original, [{ name: 'new_tool' }])

    expect(serialized).not.toBeNull()
    expect(serialized).not.toContain('\n')
    expect(JSON.parse(serialized as string)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [{ name: 'new_tool' }],
        nextCursor: 'page-2',
        _meta: { vendor: 'x' },
      },
      _meta: { top: 'y' },
    })
  })

  test('serializes an empty tools list', () => {
    const line = '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a"}]}}'
    const original = classify(line)

    const serialized = serializeToolsListResult(original, [])

    expect(JSON.parse(serialized as string)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [] },
    })
  })

  test('preserves annotations and description on re-serialized tools', () => {
    const line = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'
    const original = classify(line)

    const serialized = serializeToolsListResult(original, [
      {
        name: 'read_file',
        description: 'reads a file',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      },
    ])

    expect(JSON.parse(serialized as string).result.tools).toEqual([
      {
        name: 'read_file',
        description: 'reads a file',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      },
    ])
  })

  test('returns null when the original raw is unparseable', () => {
    const original = classify('not json at all {{{')

    expect(serializeToolsListResult(original, [])).toBeNull()
  })

  test('adds a tools array to result even if the original result had no tools key', () => {
    const original = classify('{"jsonrpc":"2.0","id":1,"result":{}}')

    const serialized = serializeToolsListResult(original, [{ name: 'a' }])

    expect(JSON.parse(serialized as string)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'a' }] },
    })
  })

  test('returns null when the original message has no result object at all', () => {
    const original = classify('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')

    expect(serializeToolsListResult(original, [{ name: 'a' }])).toBeNull()
  })

  test('never throws on malformed input', () => {
    expect(() => serializeToolsListResult(classify('{"unterminated'), [])).not.toThrow()
  })
})
