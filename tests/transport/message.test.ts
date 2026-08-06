import { describe, expect, test } from 'vitest'
import type { Verdict } from '../../src/proxy/pipeline.js'
import {
  clientMessage,
  serverMessage,
  InvalidMessageError,
  type McpMessage,
  type MessageGate,
  type MessageSink,
  type MessageTerminator,
  type MessageVerdict,
} from '../../src/transport/message.js'

describe('clientMessage / serverMessage constructors', () => {
  test.each([
    { name: 'clientMessage', build: clientMessage, origin: 'client' },
    { name: 'serverMessage', build: serverMessage, origin: 'server' },
  ] as const)('$name stamps origin "$origin" into meta', ({ build, origin }) => {
    const message = build(Buffer.from('{"a":1}'))

    expect(message.meta.origin).toBe(origin)
  })

  test.each<MessageTerminator>(['\n', '\r\n', 'none'])(
    'stores the terminator %j exactly as given',
    (terminator) => {
      const message = clientMessage(Buffer.from('x'), terminator)

      expect(message.meta.terminator).toBe(terminator)
    },
  )

  test('a message built without a terminator has no terminator key at all (non-stdio shape)', () => {
    const message = serverMessage(Buffer.from('{"b":2}'))

    expect('terminator' in message.meta).toBe(false)
  })

  test('keeps the exact same Buffer instance: bytes are never copied (byte identity)', () => {
    const bytes = Buffer.from('café 🎉 {"a":1}', 'utf8')

    const message = clientMessage(bytes, '\n')

    expect(message.bytes).toBe(bytes)
  })

  test('accepts empty bytes: a blank stdio line is a legal message', () => {
    const message = serverMessage(Buffer.alloc(0), '\r\n')

    expect(message.bytes).toHaveLength(0)
    expect(message.meta.terminator).toBe('\r\n')
  })
})

describe('message immutability', () => {
  test('the message and its meta are frozen', () => {
    const message = clientMessage(Buffer.from('x'), '\n')

    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.meta)).toBe(true)
  })

  test('mutating a frozen message throws in strict mode', () => {
    const message = clientMessage(Buffer.from('x'), '\n')
    const mutable = message as unknown as { bytes: Buffer }

    expect(() => {
      mutable.bytes = Buffer.from('tampered')
    }).toThrow(TypeError)
  })

  test('mutating frozen meta (origin or terminator) throws in strict mode', () => {
    const message = clientMessage(Buffer.from('x'), '\n')
    const mutableMeta = message.meta as unknown as { origin: string; terminator: string }

    expect(() => {
      mutableMeta.origin = 'server'
    }).toThrow(TypeError)
    expect(() => {
      mutableMeta.terminator = 'none'
    }).toThrow(TypeError)
  })
})

describe('constructor input validation', () => {
  test.each([
    { name: 'a string', bytes: 'not a buffer' },
    { name: 'a Uint8Array that is not a Buffer', bytes: new Uint8Array([1, 2]) },
    { name: 'undefined', bytes: undefined },
    { name: 'null', bytes: null },
  ])('rejects $name as bytes with InvalidMessageError', ({ bytes }) => {
    expect(() => clientMessage(bytes as unknown as Buffer)).toThrow(InvalidMessageError)
  })

  test.each([
    { name: 'a lone carriage return', terminator: '\r' },
    { name: 'an arbitrary string', terminator: 'crlf' },
    { name: 'an empty string', terminator: '' },
  ])('rejects $name as terminator with InvalidMessageError', ({ terminator }) => {
    expect(() =>
      serverMessage(Buffer.from('x'), terminator as unknown as MessageTerminator),
    ).toThrow(InvalidMessageError)
  })

  test('InvalidMessageError is a named Error subclass', () => {
    let caught: unknown
    try {
      clientMessage(42 as unknown as Buffer)
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe('InvalidMessageError')
  })
})

describe('MessageVerdict mirrors the pipeline Verdict exactly', () => {
  test('every pipeline Verdict is a MessageVerdict and vice versa (compile-time mutual assignability)', () => {
    // These assignments are the real assertion: if either union drifts from
    // the other, this test stops compiling — which is exactly the guarantee
    // Task 11 needs to swap the gate from Frame to McpMessage with a
    // type-only diff.
    const forward: Verdict = { action: 'forward' }
    const drop: Verdict = { action: 'drop' }
    const emit: MessageVerdict = { action: 'emit', bytes: Buffer.from('{"replaced":true}\n') }

    const forwardAsMessage: MessageVerdict = forward
    const dropAsMessage: MessageVerdict = drop
    const emitAsPipeline: Verdict = emit

    expect(forwardAsMessage.action).toBe('forward')
    expect(dropAsMessage.action).toBe('drop')
    expect(emitAsPipeline.action).toBe('emit')
  })
})

describe('MessageGate contract', () => {
  test('a gate may answer synchronously or asynchronously, like GateFn', async () => {
    const syncGate: MessageGate = () => ({ action: 'forward' })
    const asyncGate: MessageGate = () => Promise.resolve({ action: 'drop' })
    const message: McpMessage = clientMessage(Buffer.from('{"m":1}'), '\n')

    const syncVerdict = syncGate(message)
    const asyncVerdict = await asyncGate(message)

    expect(syncVerdict).toEqual({ action: 'forward' })
    expect(asyncVerdict).toEqual({ action: 'drop' })
  })
})

describe('MessageSink contract shape', () => {
  test('an OrderedWriter-style serialized writer satisfies MessageSink structurally', async () => {
    const written: McpMessage[] = []
    const sink: MessageSink = {
      write(message: McpMessage): Promise<void> {
        written.push(message)
        return Promise.resolve()
      },
      dispose(): void {
        // Idempotent by contract; nothing to release here.
      },
    }

    await sink.write(serverMessage(Buffer.from('x'), '\n'))
    sink.dispose()
    sink.dispose()

    expect(written).toHaveLength(1)
  })
})
