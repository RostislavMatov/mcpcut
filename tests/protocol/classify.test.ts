import { describe, expect, test } from 'vitest'
import { classify } from '../../src/protocol/classify.js'

describe('classify', () => {
  test('classifies a request (has id and method)', () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

    const result = classify(line)

    expect(result).toEqual({
      kind: 'request',
      id: 1,
      method: 'tools/list',
      raw: line,
    })
  })

  test('classifies a response with a result', () => {
    const line = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'

    const result = classify(line)

    expect(result).toEqual({
      kind: 'response',
      id: 1,
      isError: false,
      raw: line,
    })
  })

  test('classifies a response with an error', () => {
    const line =
      '{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Method not found"}}'

    const result = classify(line)

    expect(result).toEqual({
      kind: 'response',
      id: 2,
      isError: true,
      errorCode: -32601,
      errorMessage: 'Method not found',
      raw: line,
    })
  })

  test('classifies a notification (method, no id)', () => {
    const line = '{"jsonrpc":"2.0","method":"notifications/initialized"}'

    const result = classify(line)

    expect(result).toEqual({
      kind: 'notification',
      method: 'notifications/initialized',
      raw: line,
    })
  })

  test('classifies unparseable JSON garbage as invalid', () => {
    const line = 'not json at all {{{'

    const result = classify(line)

    expect(result.kind).toBe('invalid')
    expect(result.raw).toBe(line)
  })

  test('classifies an empty string as invalid', () => {
    const line = ''

    const result = classify(line)

    expect(result.kind).toBe('invalid')
    expect(result.raw).toBe(line)
  })

  test('classifies a bare JSON number as invalid', () => {
    const line = '42'

    const result = classify(line)

    expect(result.kind).toBe('invalid')
    expect(result.raw).toBe(line)
  })

  test('classifies a bare JSON string as invalid', () => {
    const line = '"hello"'

    const result = classify(line)

    expect(result.kind).toBe('invalid')
    expect(result.raw).toBe(line)
  })

  test('classifies a JSON array (batch request) as invalid for now', () => {
    // NOTE: JSON-RPC 2.0 batching via top-level arrays is not yet handled by
    // this thin classifier. Batches are intentionally classified as
    // 'invalid' rather than silently misinterpreted; revisit if/when batch
    // support becomes a requirement.
    const line = '[{"jsonrpc":"2.0","id":1,"method":"ping"}]'

    const result = classify(line)

    expect(result.kind).toBe('invalid')
    expect(result.raw).toBe(line)
  })

  test('classifies JSON-RPC-shaped input missing the jsonrpc field as invalid', () => {
    const line = '{"id":1,"method":"tools/list"}'

    const result = classify(line)

    expect(result.kind).toBe('invalid')
    expect(result.raw).toBe(line)
  })

  test('classifies a request with id: null', () => {
    const line = '{"jsonrpc":"2.0","id":null,"method":"ping"}'

    const result = classify(line)

    expect(result).toEqual({
      kind: 'request',
      id: null,
      method: 'ping',
      raw: line,
    })
  })

  test('classifies a request with id: 0 (falsy id must not be treated as missing)', () => {
    const line = '{"jsonrpc":"2.0","id":0,"method":"ping"}'

    const result = classify(line)

    expect(result).toEqual({
      kind: 'request',
      id: 0,
      method: 'ping',
      raw: line,
    })
  })

  test('classifies a response with id: 0 (falsy id must not be treated as missing)', () => {
    const line = '{"jsonrpc":"2.0","id":0,"result":null}'

    const result = classify(line)

    expect(result).toEqual({
      kind: 'response',
      id: 0,
      isError: false,
      raw: line,
    })
  })

  test('classifies a request with a string id', () => {
    const line = '{"jsonrpc":"2.0","id":"abc-123","method":"ping"}'

    const result = classify(line)

    expect(result).toEqual({
      kind: 'request',
      id: 'abc-123',
      method: 'ping',
      raw: line,
    })
  })

  test('classifies an object with method as a non-string as invalid', () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":123}'

    const result = classify(line)

    expect(result.kind).toBe('invalid')
    expect(result.raw).toBe(line)
  })

  test('classifies an object with neither method nor result/error as invalid', () => {
    const line = '{"jsonrpc":"2.0","id":1}'

    const result = classify(line)

    expect(result.kind).toBe('invalid')
    expect(result.raw).toBe(line)
  })

  test('classifies a JSON object with jsonrpc set to the wrong version as invalid', () => {
    const line = '{"jsonrpc":"1.0","id":1,"method":"ping"}'

    const result = classify(line)

    expect(result.kind).toBe('invalid')
    expect(result.raw).toBe(line)
  })

  test('classifies null as invalid', () => {
    const line = 'null'

    const result = classify(line)

    expect(result.kind).toBe('invalid')
    expect(result.raw).toBe(line)
  })

  test('never throws on malformed input', () => {
    expect(() => classify('{"unterminated')).not.toThrow()
    expect(() => classify('{}')).not.toThrow()
    expect(() => classify('   ')).not.toThrow()
  })
})
