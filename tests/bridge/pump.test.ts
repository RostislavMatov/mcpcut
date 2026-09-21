import { describe, expect, test } from 'vitest'
import { ERROR_CODE_BRIDGE_TRANSPORT } from '../../src/bridge/constants.js'
import { runBridge, type BridgeEnd } from '../../src/bridge/pump.js'
import {
  clientMessage,
  serverMessage,
  type McpMessage,
  type MessageSink,
  type MessageSource,
} from '../../src/transport/message.js'
import {
  SessionExpiredError,
  SseStreamError,
  UpstreamConnectionError,
  UpstreamHttpStatusError,
} from '../../src/transport/http/client.js'

/**
 * The two-directional pump (plan task 4): everything the bridge does once the
 * address is parsed and the client exists. No network here — both sides are
 * fakes, because what is under test is the pumping discipline, not HTTP.
 */

const HOST = 'plane.example:8090'

/** A `MessageSource` a test drives by hand. */
function fakeSource() {
  let onMessage: ((message: McpMessage) => void) | undefined
  let onError: ((error: unknown) => void) | undefined
  let onEnd: (() => void) | undefined
  let disposals = 0

  return {
    source: {
      onMessage: (handler: (message: McpMessage) => void) => {
        onMessage = handler
      },
      onError: (handler: (error: unknown) => void) => {
        onError = handler
      },
      onEnd: (handler: () => void) => {
        onEnd = handler
      },
      dispose: () => {
        disposals += 1
      },
    } satisfies MessageSource,
    emit: (message: McpMessage) => onMessage?.(message),
    fail: (error: unknown) => onError?.(error),
    end: () => onEnd?.(),
    disposals: () => disposals,
  }
}

interface FakeSink {
  readonly sink: MessageSink
  readonly written: McpMessage[]
  /** Makes the NEXT `write` hang until the returned function is called. */
  holdNext(): () => void
  /** Makes the next `write` reject with `error`. */
  failNext(error: unknown): void
}

function fakeSink(): FakeSink {
  const written: McpMessage[] = []
  let hold: Promise<void> | undefined
  let release: (() => void) | undefined
  let nextError: unknown
  let hasNextError = false

  return {
    written,
    sink: {
      write: async (message: McpMessage) => {
        // The hold is taken FIRST, so a write can be parked and then made to
        // fail on release — which is how a real POST that was already on the
        // wire when something else went wrong behaves.
        const pending = hold
        hold = undefined
        if (pending !== undefined) await pending
        if (hasNextError) {
          hasNextError = false
          const error = nextError
          throw error
        }
        written.push(message)
      },
      dispose: () => undefined,
    },
    holdNext: () => {
      hold = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => release?.()
    },
    failNext: (error: unknown) => {
      nextError = error
      hasNextError = true
    },
  }
}

interface Rig {
  readonly clientIn: ReturnType<typeof fakeSource>
  readonly clientOut: FakeSink
  readonly serviceIn: ReturnType<typeof fakeSource>
  readonly serviceOut: FakeSink
  readonly diagnostics: string[]
  closes(): number
  readonly ended: Promise<BridgeEnd>
}

function startRig(): Rig {
  const clientIn = fakeSource()
  const clientOut = fakeSink()
  const serviceIn = fakeSource()
  const serviceOut = fakeSink()
  const diagnostics: string[] = []
  let closes = 0

  const ended = runBridge({
    client: { source: clientIn.source, sink: clientOut.sink },
    service: {
      source: serviceIn.source,
      sink: serviceOut.sink,
      close: () => {
        closes += 1
        return Promise.resolve()
      },
    },
    onDiagnostic: (line) => diagnostics.push(line),
  })

  return { clientIn, clientOut, serviceIn, serviceOut, diagnostics, closes: () => closes, ended }
}

/** Lets already-scheduled microtasks (and one macrotask) run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function jsonOf(message: McpMessage): Record<string, unknown> {
  return JSON.parse(message.bytes.toString('utf8')) as Record<string, unknown>
}

describe('bytes cross unchanged, in both directions', () => {
  test('a client message reaches the service as the very same object', async () => {
    const rig = startRig()
    const message = clientMessage(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'), '\n')

    rig.clientIn.emit(message)
    await settle()

    expect(rig.serviceOut.written).toEqual([message])
    // Byte identity, not merely equality: the bridge relays, it does not
    // re-serialize.
    expect(rig.serviceOut.written[0]?.bytes).toBe(message.bytes)

    rig.clientIn.end()
    await rig.ended
  })

  test('a service message reaches the client as the very same object', async () => {
    const rig = startRig()
    const message = serverMessage(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}'))

    rig.serviceIn.emit(message)
    await settle()

    expect(rig.clientOut.written).toEqual([message])
    expect(rig.clientOut.written[0]?.bytes).toBe(message.bytes)

    rig.clientIn.end()
    await rig.ended
  })

  test.each([
    ['\n' as const, 'a newline-terminated line'],
    ['\r\n' as const, 'a CRLF-terminated line'],
    ['none' as const, 'a fragment that never had a terminator'],
  ])('%s survives: %s', async (terminator) => {
    const rig = startRig()
    const message = clientMessage(Buffer.from('{"jsonrpc":"2.0","method":"ping"}'), terminator)

    rig.clientIn.emit(message)
    await settle()

    expect(rig.serviceOut.written[0]?.meta.terminator).toBe(terminator)

    rig.clientIn.end()
    await rig.ended
  })
})

describe('a slow write does not hold up the next one', () => {
  test('the second message is delivered while the first is still in flight', async () => {
    const rig = startRig()
    const release = rig.serviceOut.holdNext()
    const slow = clientMessage(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call"}'), '\n')
    const quick = clientMessage(
      Buffer.from('{"jsonrpc":"2.0","method":"notifications/cancelled"}'),
      '\n',
    )

    rig.clientIn.emit(slow)
    rig.clientIn.emit(quick)
    await settle()

    // The whole reason the bridge does not await each write: a `tools/call`
    // waiting on a human approval holds its POST open for minutes, and the
    // cancellation for it must not queue behind it.
    expect(rig.serviceOut.written).toEqual([quick])

    release()
    await settle()
    expect(rig.serviceOut.written).toEqual([quick, slow])

    rig.clientIn.end()
    await rig.ended
  })
})

describe('a failure that costs one request, and no more', () => {
  test.each([
    ['a numeric id', 7, 7],
    ['a string id', 'call-7', 'call-7'],
  ])('%s gets a transport error back, and the bridge lives on', async (_name, id, expected) => {
    const rig = startRig()
    rig.serviceOut.failNext(new UpstreamConnectionError('POST', HOST, { code: 'ECONNRESET' }))

    rig.clientIn.emit(
      clientMessage(
        Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call' })),
        '\n',
      ),
    )
    await settle()

    expect(rig.clientOut.written).toHaveLength(1)
    const answer = jsonOf(rig.clientOut.written[0] as McpMessage)
    expect(answer['id']).toBe(expected)
    expect(answer['error']).toMatchObject({ code: ERROR_CODE_BRIDGE_TRANSPORT })
    expect(rig.diagnostics.join('')).toContain('network')

    // Alive: the next message still crosses.
    const next = clientMessage(Buffer.from('{"jsonrpc":"2.0","id":8,"method":"ping"}'), '\n')
    rig.clientIn.emit(next)
    await settle()
    expect(rig.serviceOut.written).toEqual([next])

    rig.clientIn.end()
    expect((await rig.ended).reason).toBe('client-ended')
  })

  test('the synthesized answer is one line the stdio sink can frame', async () => {
    const rig = startRig()
    rig.serviceOut.failNext(new UpstreamHttpStatusError('POST', 429, HOST))

    rig.clientIn.emit(
      clientMessage(Buffer.from('{"jsonrpc":"2.0","id":3,"method":"tools/call"}'), '\n'),
    )
    await settle()

    const written = rig.clientOut.written[0] as McpMessage
    expect(written.bytes.includes(0x0a)).toBe(false)
    expect(written.meta.terminator).toBe('\n')

    rig.clientIn.end()
    await rig.ended
  })

  test('an undeliverable NOTIFICATION gets a diagnostic and nothing else', async () => {
    const rig = startRig()
    rig.serviceOut.failNext(new UpstreamConnectionError('POST', HOST, { code: 'ECONNRESET' }))

    rig.clientIn.emit(
      clientMessage(Buffer.from('{"jsonrpc":"2.0","method":"notifications/initialized"}'), '\n'),
    )
    await settle()

    // There is no return address for a notification, so nothing is written
    // back; the operator still learns it was dropped.
    expect(rig.clientOut.written).toEqual([])
    expect(rig.diagnostics.join('')).toContain('notifications/initialized')

    rig.clientIn.end()
    await rig.ended
  })

  test('a request with a null id gets a diagnostic and nothing else', async () => {
    const rig = startRig()
    rig.serviceOut.failNext(new UpstreamConnectionError('POST', HOST, { code: 'ECONNRESET' }))

    rig.clientIn.emit(
      clientMessage(Buffer.from('{"jsonrpc":"2.0","id":null,"method":"tools/call"}'), '\n'),
    )
    await settle()

    expect(rig.clientOut.written).toEqual([])

    rig.clientIn.end()
    await rig.ended
  })

  test('an unparseable client message that could not be sent is only reported', async () => {
    const rig = startRig()
    rig.serviceOut.failNext(new UpstreamConnectionError('POST', HOST, { code: 'ECONNRESET' }))

    rig.clientIn.emit(clientMessage(Buffer.from('not json at all'), '\n'))
    await settle()

    expect(rig.clientOut.written).toEqual([])
    expect(rig.diagnostics.length).toBeGreaterThan(0)

    rig.clientIn.end()
    await rig.ended
  })
})

describe('one failure is one line, however many channels report it', () => {
  test('the real client emits a write failure on the source channel TOO — say it once', async () => {
    const rig = startRig()
    const error = new UpstreamConnectionError('POST', HOST, { code: 'ECONNREFUSED' })
    rig.serviceOut.failNext(error)

    // `client.ts`'s `write` does `channel.emitError(error); throw error` — so a
    // single refused POST arrives here twice. The forward's own line carries
    // the method and the id; the source's carried neither and was labelled
    // "service stream", which pointed an operator at the wrong thing
    // entirely (TS review 2026-09-21, MEDIUM).
    rig.clientIn.emit(
      clientMessage(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'), '\n'),
    )
    rig.serviceIn.fail(error)
    await settle()

    expect(rig.diagnostics).toHaveLength(1)
    expect(rig.diagnostics[0]).toContain('tools/list')

    rig.clientIn.end()
    await rig.ended
  })

  test('a failure with no write behind it is still reported, and not called a stream', async () => {
    const rig = startRig()

    // The close-time DELETE failing, for instance: nothing is in flight, so
    // this line is the only account of it there will be.
    rig.serviceIn.fail(new UpstreamConnectionError('DELETE', HOST, { code: 'ECONNREFUSED' }))
    await settle()

    expect(rig.diagnostics).toHaveLength(1)
    expect(rig.diagnostics[0]).toContain('DELETE')
    expect(rig.diagnostics[0]).not.toContain('service stream')

    rig.clientIn.end()
    await rig.ended
  })
})

describe('a failure that ends the bridge', () => {
  test('401 on a write ends it as unauthorized', async () => {
    const rig = startRig()
    rig.serviceOut.failNext(new UpstreamHttpStatusError('POST', 401, HOST))

    rig.clientIn.emit(clientMessage(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"x"}'), '\n'))

    const end = await rig.ended
    expect(end).toEqual({ reason: 'fatal', failure: { kind: 'unauthorized' } })
    // No transport error is synthesized for a fatal failure: the bridge is
    // about to exit and say why on stderr.
    expect(rig.clientOut.written).toEqual([])
  })

  test('an expired session reported on the service source ends it', async () => {
    const rig = startRig()

    rig.serviceIn.fail(new SessionExpiredError(HOST))

    expect(await rig.ended).toEqual({ reason: 'fatal', failure: { kind: 'session-expired' } })
  })

  test('a lost SSE stream ends it', async () => {
    const rig = startRig()

    rig.serviceIn.fail(new SseStreamError(HOST, 5, null))

    expect(await rig.ended).toEqual({ reason: 'fatal', failure: { kind: 'stream-lost' } })
  })

  test('a NON-fatal error on the service source is reported, not fatal', async () => {
    const rig = startRig()

    rig.serviceIn.fail(new UpstreamHttpStatusError('POST', 500, HOST))
    await settle()

    expect(rig.diagnostics.join('')).toContain('500')
    const next = clientMessage(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}'), '\n')
    rig.clientIn.emit(next)
    await settle()
    expect(rig.serviceOut.written).toEqual([next])

    rig.clientIn.end()
    expect((await rig.ended).reason).toBe('client-ended')
  })

  test('a fatal that lands after the client hung up is reported, not swallowed', async () => {
    const rig = startRig()
    // The client writes and immediately hangs up; the service's 401 is still
    // in flight. The ENDING is the client's — it left — but an operator
    // debugging a bad token must still be told what the service said.
    const release = rig.serviceOut.holdNext()
    rig.serviceOut.failNext(new UpstreamHttpStatusError('POST', 401, HOST))
    rig.clientIn.emit(clientMessage(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"x"}'), '\n'))
    rig.clientIn.end()
    release()
    await settle()

    expect(await rig.ended).toEqual({ reason: 'client-ended' })
    expect(rig.diagnostics.join('')).toContain('unauthorized')
  })

  test('a second fatal is NOT reported when the outcome is already a fatal', async () => {
    const rig = startRig()

    // Both halves of a dead connection fail for the same reason; the caller
    // is about to name that reason, so a second line would read as a second
    // problem.
    rig.serviceIn.fail(new UpstreamHttpStatusError('GET', 401, HOST))
    rig.serviceIn.fail(new UpstreamHttpStatusError('POST', 401, HOST))
    await settle()

    expect(await rig.ended).toEqual({ reason: 'fatal', failure: { kind: 'unauthorized' } })
    expect(rig.diagnostics).toEqual([])
  })

  test('a straggler is not answered after the bridge has ended — and says so', async () => {
    const rig = startRig()
    const release = rig.serviceOut.holdNext()
    // Two concurrent calls. The first fails fatally; the second is still in
    // flight and then fails with an ordinary network error.
    rig.clientIn.emit(clientMessage(Buffer.from('{"jsonrpc":"2.0","id":2,"method":"tools/call"}'), '\n'))
    rig.serviceOut.failNext(new UpstreamHttpStatusError('POST', 401, HOST))
    rig.clientIn.emit(clientMessage(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call"}'), '\n'))
    await settle()
    expect(await rig.ended).toEqual({ reason: 'fatal', failure: { kind: 'unauthorized' } })

    rig.serviceOut.failNext(new UpstreamConnectionError('POST', HOST, { code: 'ECONNRESET' }))
    release()
    await settle()

    // The caller is about to tear the bridge down, so an answer written now
    // would land on a disposed sink and vanish. Better to say plainly that
    // the request went unanswered than to log a delivery that never happened
    // (TS review 2026-09-21, HIGH).
    expect(rig.clientOut.written).toEqual([])
    expect(rig.diagnostics.join('')).toContain('unanswered')
  })

  test('two fatal failures in a row still produce exactly one outcome', async () => {
    const rig = startRig()

    rig.serviceIn.fail(new SessionExpiredError(HOST))
    rig.serviceIn.fail(new SseStreamError(HOST, 5, null))
    rig.clientIn.end()

    expect(await rig.ended).toEqual({ reason: 'fatal', failure: { kind: 'session-expired' } })
    expect(rig.closes()).toBeLessThanOrEqual(1)
  })
})

describe('the client hanging up is the ordinary ending', () => {
  test('closes the service once and reports client-ended', async () => {
    const rig = startRig()

    rig.clientIn.end()

    expect(await rig.ended).toEqual({ reason: 'client-ended' })
    expect(rig.closes()).toBe(1)
  })

  test('a second end changes nothing', async () => {
    const rig = startRig()

    rig.clientIn.end()
    rig.clientIn.end()
    await rig.ended

    expect(rig.closes()).toBe(1)
  })

  test('a service that fails to close is reported, and the bridge still ends', async () => {
    const clientIn = fakeSource()
    const diagnostics: string[] = []
    const ended = runBridge({
      client: { source: clientIn.source, sink: fakeSink().sink },
      service: {
        source: fakeSource().source,
        sink: fakeSink().sink,
        close: () => Promise.reject(new Error('socket already gone')),
      },
      onDiagnostic: (line) => diagnostics.push(line),
    })

    clientIn.end()

    // A failure while letting go of the service is not the agent's problem:
    // the ending is still the ordinary one, and the line goes to stderr.
    expect(await ended).toEqual({ reason: 'client-ended' })
    expect(diagnostics.join('')).toContain('closing the service connection')
  })

  test('a client-side transport error is reported, and ends the bridge cleanly', async () => {
    const rig = startRig()

    rig.clientIn.fail(new Error('stdin exploded'))

    expect((await rig.ended).reason).toBe('client-ended')
    expect(rig.diagnostics.length).toBeGreaterThan(0)
  })

  test('a failure writing to the client is reported, never re-sent to the client', async () => {
    const rig = startRig()
    rig.clientOut.failNext(new Error('EPIPE'))

    rig.serviceIn.emit(serverMessage(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}')))
    await settle()

    expect(rig.diagnostics.length).toBeGreaterThan(0)

    rig.clientIn.end()
    expect((await rig.ended).reason).toBe('client-ended')
  })
})
