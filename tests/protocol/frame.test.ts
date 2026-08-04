import { describe, expect, test } from 'vitest'
import { createLineFramer } from '../../src/protocol/frame.js'

describe('createLineFramer', () => {
  test('returns a complete line without the trailing newline', () => {
    const framer = createLineFramer()

    const lines = framer.push(Buffer.from('hello world\n'))

    expect(lines).toEqual(['hello world'])
  })

  test('returns an empty array when no newline has arrived yet', () => {
    const framer = createLineFramer()

    const lines = framer.push(Buffer.from('partial message without newline'))

    expect(lines).toEqual([])
  })

  test('emits multiple messages contained in a single chunk', () => {
    const framer = createLineFramer()

    const lines = framer.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":3}\n'))

    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  test('reassembles one message split across many chunks', () => {
    const framer = createLineFramer()

    const first = framer.push(Buffer.from('{"jsonrpc":"2.'))
    const second = framer.push(Buffer.from('0","method":"pi'))
    const third = framer.push(Buffer.from('ng"}\n'))

    expect(first).toEqual([])
    expect(second).toEqual([])
    expect(third).toEqual(['{"jsonrpc":"2.0","method":"ping"}'])
  })

  test('reassembles a UTF-8 multibyte character split across the chunk boundary', () => {
    const framer = createLineFramer()
    // "café 🎉\n" encoded as UTF-8, then split mid-multibyte-sequence
    // (both é as 2 bytes and 🎉 as a 4-byte surrogate-pair emoji).
    const full = Buffer.from('café 🎉\n', 'utf8')
    const splitPoint = full.length - 3 // lands inside the emoji's byte sequence

    const first = framer.push(full.subarray(0, splitPoint))
    const second = framer.push(full.subarray(splitPoint))

    expect(first).toEqual([])
    expect(second).toEqual(['café 🎉'])
  })

  test('skips empty lines produced by consecutive newlines', () => {
    const framer = createLineFramer()

    const lines = framer.push(Buffer.from('one\n\n\ntwo\n'))

    expect(lines).toEqual(['one', 'two'])
  })

  test('strips a trailing carriage return for CRLF-terminated lines', () => {
    const framer = createLineFramer()

    const lines = framer.push(Buffer.from('one\r\ntwo\r\n'))

    expect(lines).toEqual(['one', 'two'])
  })

  test('tolerates a lone carriage return in the middle of a line (not stripped)', () => {
    const framer = createLineFramer()

    const lines = framer.push(Buffer.from('a\rb\n'))

    expect(lines).toEqual(['a\rb'])
  })

  test('buffers an incomplete tail across push calls without emitting it early', () => {
    const framer = createLineFramer()

    const first = framer.push(Buffer.from('line-one\nline-two-incomplete'))
    const second = framer.push(Buffer.from('-still-going'))
    const third = framer.push(Buffer.from('-done\n'))

    expect(first).toEqual(['line-one'])
    expect(second).toEqual([])
    expect(third).toEqual(['line-two-incomplete-still-going-done'])
  })

  test('flushes an unterminated line once it exceeds maxBufferBytes, instead of growing forever', () => {
    const maxBufferBytes = 8
    const framer = createLineFramer({ maxBufferBytes })

    // 10 bytes, no newline: exceeds the 8-byte guard.
    const lines = framer.push(Buffer.from('0123456789'))

    expect(lines).toEqual(['0123456789'])
  })

  test('resumes framing normally after an overflow flush', () => {
    const maxBufferBytes = 8
    const framer = createLineFramer({ maxBufferBytes })

    const overflowLines = framer.push(Buffer.from('0123456789'))
    const nextLines = framer.push(Buffer.from('next-message\n'))

    expect(overflowLines).toEqual(['0123456789'])
    expect(nextLines).toEqual(['next-message'])
  })

  test('does not flush a buffered line that is still within maxBufferBytes', () => {
    const maxBufferBytes = 8
    const framer = createLineFramer({ maxBufferBytes })

    const lines = framer.push(Buffer.from('short'))

    expect(lines).toEqual([])
  })

  test('uses MAX_LINE_BUFFER_BYTES from config as the default guard', async () => {
    const { MAX_LINE_BUFFER_BYTES } = await import('../../src/config.js')
    const framer = createLineFramer()

    const justUnderLimit = Buffer.alloc(MAX_LINE_BUFFER_BYTES, 'x')
    const lines = framer.push(justUnderLimit)

    // Exactly at the limit: not yet flushed (guard triggers only once exceeded).
    expect(lines).toEqual([])
  })

  test('handles an empty chunk push without error', () => {
    const framer = createLineFramer()

    const lines = framer.push(Buffer.alloc(0))

    expect(lines).toEqual([])
  })
})
