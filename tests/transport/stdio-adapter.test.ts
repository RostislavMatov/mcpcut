import { randomBytes } from 'node:crypto'
import { Writable } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import { createFrameSplitter, type Frame, type Terminator } from '../../src/protocol/split.js'
import { createOrderedWriter } from '../../src/proxy/writer.js'
import {
  clientMessage,
  serverMessage,
  type McpMessage,
  type MessageOrigin,
} from '../../src/transport/message.js'
import {
  createStdioMessageSink,
  frameToMessage,
  messageToChunk,
  EmbeddedNewlineError,
  OverflowFrameError,
} from '../../src/transport/stdio-adapter.js'

/** Builds a splitter-shaped frame literal for table-driven tests. */
function makeFrame(content: Buffer, terminator: Terminator, reason: Frame['reason']): Frame {
  return Object.freeze({
    bytes: content,
    terminator,
    isBlank: content.length === 0,
    reason,
  })
}

const TERMINATOR_BYTES: Readonly<Record<Terminator, Buffer>> = {
  '\n': Buffer.from('\n'),
  '\r\n': Buffer.from('\r\n'),
  none: Buffer.alloc(0),
}

describe('frameToMessage', () => {
  test.each<{ label: string; content: Buffer; terminator: Terminator; reason: Frame['reason'] }>([
    { label: 'LF-terminated JSON', content: Buffer.from('{"a":1}'), terminator: '\n', reason: 'line' },
    { label: 'CRLF-terminated JSON', content: Buffer.from('{"a":1}'), terminator: '\r\n', reason: 'line' },
    { label: 'unterminated eof tail', content: Buffer.from('partial'), terminator: 'none', reason: 'eof' },
    { label: 'blank LF line', content: Buffer.alloc(0), terminator: '\n', reason: 'line' },
    { label: 'blank CRLF line', content: Buffer.alloc(0), terminator: '\r\n', reason: 'line' },
    { label: 'multibyte UTF-8', content: Buffer.from('café 🎉 → ok', 'utf8'), terminator: '\n', reason: 'line' },
    { label: 'embedded lone CR', content: Buffer.from('a\rb'), terminator: '\n', reason: 'line' },
  ])('preserves bytes and terminator 1:1 for $label', ({ content, terminator, reason }) => {
    const frame = makeFrame(content, terminator, reason)

    const message = frameToMessage(frame, 'client')

    expect(message.bytes).toBe(frame.bytes)
    expect(message.meta.terminator).toBe(terminator)
  })

  test.each<MessageOrigin>(['client', 'server'])('stamps origin %j into meta', (origin) => {
    const frame = makeFrame(Buffer.from('x'), '\n', 'line')

    expect(frameToMessage(frame, origin).meta.origin).toBe(origin)
  })

  test('converts a blank frame losslessly (the pipeline forwards blanks past the gate; conversion must not lose them)', () => {
    const frame = makeFrame(Buffer.alloc(0), '\n', 'line')

    const message = frameToMessage(frame, 'server')

    expect(message.bytes).toHaveLength(0)
    expect(messageToChunk(message)).toEqual(Buffer.from('\n'))
  })

  test('refuses an overflow frame with a typed error: it must never enter the message layer (fail-closed, C1)', () => {
    const splitter = createFrameSplitter({ maxBufferBytes: 8 })
    const [overflowFrame] = splitter.push(Buffer.from('0123456789ABCDEF'))
    expect(overflowFrame?.reason).toBe('overflow')

    expect(() => frameToMessage(overflowFrame as Frame, 'client')).toThrow(OverflowFrameError)
  })

  test('OverflowFrameError is a named Error subclass mentioning the frame size', () => {
    const splitter = createFrameSplitter({ maxBufferBytes: 4 })
    const [overflowFrame] = splitter.push(Buffer.from('12345678'))

    let caught: unknown
    try {
      frameToMessage(overflowFrame as Frame, 'server')
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe('OverflowFrameError')
    expect((caught as Error).message).toContain('8')
  })
})

describe('messageToChunk', () => {
  test.each<{ label: string; content: Buffer; terminator: Terminator }>([
    { label: 'LF', content: Buffer.from('{"a":1}'), terminator: '\n' },
    { label: 'CRLF', content: Buffer.from('{"a":1}'), terminator: '\r\n' },
    { label: 'none (eof tail)', content: Buffer.from('partial'), terminator: 'none' },
    { label: 'blank LF', content: Buffer.alloc(0), terminator: '\n' },
    { label: 'blank CRLF', content: Buffer.alloc(0), terminator: '\r\n' },
    { label: 'empty none', content: Buffer.alloc(0), terminator: 'none' },
    { label: 'multibyte UTF-8', content: Buffer.from('café 🎉', 'utf8'), terminator: '\r\n' },
  ])('reproduces content + terminator bytes exactly for $label', ({ content, terminator }) => {
    const message = clientMessage(content, terminator)

    const chunk = messageToChunk(message)

    expect(chunk).toEqual(Buffer.concat([content, TERMINATOR_BYTES[terminator]]))
  })

  test('appends "\\n" to a terminator-less (non-stdio) message: the stdio wire requires line framing', () => {
    const message = serverMessage(Buffer.from('{"from":"http"}'))

    expect(messageToChunk(message)).toEqual(Buffer.from('{"from":"http"}\n'))
  })

  test('a terminator-less message with an embedded "\\n" is a contract violation, not silent wire corruption', () => {
    const message = clientMessage(Buffer.from('{"a":1}\n{"b":2}'))

    expect(() => messageToChunk(message)).toThrow(EmbeddedNewlineError)
  })

  test('EmbeddedNewlineError is a named Error subclass reporting the offending byte offset', () => {
    let caught: unknown
    try {
      messageToChunk(serverMessage(Buffer.from('ab\ncd')))
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe('EmbeddedNewlineError')
    expect((caught as Error).message).toContain('2')
  })

  test('an embedded lone "\\r" in a terminator-less message is legal wire content', () => {
    const message = clientMessage(Buffer.from('a\rb'))

    expect(messageToChunk(message)).toEqual(Buffer.from('a\rb\n'))
  })
})

describe('frame → message → chunk round trip (property style)', () => {
  test('crafted stream with CRLF, blank lines, UTF-8 boundaries and an eof tail reassembles byte-for-byte', () => {
    const original = Buffer.from('café 🎉 {"a":1}\r\n\r\n\n{"b":2}\n{"tail":true} no newline', 'utf8')
    const splitter = createFrameSplitter()
    // Unaligned boundaries, one inside the multibyte "café 🎉" run.
    const boundaries = [3, 7, 20, original.length - 5]

    const frames: Frame[] = []
    let cursor = 0
    for (const boundary of boundaries) {
      frames.push(...splitter.push(original.subarray(cursor, boundary)))
      cursor = boundary
    }
    frames.push(...splitter.push(original.subarray(cursor)))
    frames.push(...splitter.flush())

    const rebuilt = Buffer.concat(
      frames.map((frame) => messageToChunk(frameToMessage(frame, 'server'))),
    )

    expect(rebuilt).toEqual(original)
  })

  test('random byte streams split at random boundaries reassemble byte-for-byte through the adapter', () => {
    const ROUNDS = 25
    const STREAM_BYTES = 512
    const MAX_PUSH_STEP = 64

    for (let round = 0; round < ROUNDS; round += 1) {
      // Raw random bytes naturally contain 0x0a and 0x0d, producing a mix of
      // LF frames, CRLF frames, blank frames, and a trailing eof fragment.
      const original = randomBytes(STREAM_BYTES)
      const splitter = createFrameSplitter()
      const frames: Frame[] = []

      let cursor = 0
      while (cursor < original.length) {
        const step = 1 + Math.floor(Math.random() * MAX_PUSH_STEP)
        frames.push(...splitter.push(original.subarray(cursor, cursor + step)))
        cursor += step
      }
      frames.push(...splitter.flush())

      const rebuilt = Buffer.concat(
        frames.map((frame) => messageToChunk(frameToMessage(frame, 'client'))),
      )

      expect(rebuilt).toEqual(original)
    }
  })
})

/** A minimal fake OrderedWriter recording what it was asked to write. */
function createRecordingWriter(): {
  writer: { writeMessage(bytes: Buffer): Promise<void>; dispose(): void }
  written: Buffer[]
  disposeCalls: () => number
} {
  const written: Buffer[] = []
  const dispose = vi.fn()
  return {
    writer: {
      writeMessage: (bytes: Buffer) => {
        written.push(bytes)
        return Promise.resolve()
      },
      dispose,
    },
    written,
    disposeCalls: () => dispose.mock.calls.length,
  }
}

describe('createStdioMessageSink', () => {
  test('serializes each message as content + terminator into the underlying writer, in call order', async () => {
    const { writer, written } = createRecordingWriter()
    const sink = createStdioMessageSink(writer)

    await sink.write(clientMessage(Buffer.from('{"a":1}'), '\n'))
    await sink.write(clientMessage(Buffer.from('{"b":2}'), '\r\n'))
    await sink.write(clientMessage(Buffer.from('tail'), 'none'))
    await sink.write(clientMessage(Buffer.from('{"from":"http"}')))

    expect(written.map((bytes) => bytes.toString('utf8'))).toEqual([
      '{"a":1}\n',
      '{"b":2}\r\n',
      'tail',
      '{"from":"http"}\n',
    ])
  })

  test('end-to-end through a real OrderedWriter: destination bytes equal the messages\' wire form', async () => {
    const chunks: Buffer[] = []
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk)
        callback()
      },
    })
    const writer = createOrderedWriter(destination)
    const sink = createStdioMessageSink(writer)

    const messages: McpMessage[] = [
      serverMessage(Buffer.from('{"a":1}'), '\r\n'),
      serverMessage(Buffer.alloc(0), '\n'),
      serverMessage(Buffer.from('partial'), 'none'),
    ]
    await Promise.all(messages.map((message) => sink.write(message)))

    expect(Buffer.concat(chunks)).toEqual(Buffer.from('{"a":1}\r\n\npartial'))
  })

  test('a framing violation rejects the write and never reaches the underlying writer', async () => {
    const { writer, written } = createRecordingWriter()
    const sink = createStdioMessageSink(writer)

    await expect(sink.write(clientMessage(Buffer.from('a\nb')))).rejects.toBeInstanceOf(
      EmbeddedNewlineError,
    )

    expect(written).toEqual([])
  })

  test('dispose delegates to the underlying writer exactly once, and double dispose is safe', () => {
    const { writer, disposeCalls } = createRecordingWriter()
    const sink = createStdioMessageSink(writer)

    expect(() => {
      sink.dispose()
      sink.dispose()
    }).not.toThrow()

    expect(disposeCalls()).toBe(1)
  })

  test('a write issued after dispose resolves as a no-op without reaching the writer', async () => {
    const { writer, written } = createRecordingWriter()
    const sink = createStdioMessageSink(writer)

    sink.dispose()
    await expect(sink.write(clientMessage(Buffer.from('late'), '\n'))).resolves.toBeUndefined()

    expect(written).toEqual([])
  })
})
