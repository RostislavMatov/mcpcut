import { describe, expect, test } from 'vitest'
import {
  CONSOLE_API_RUN_PATH,
  CONSOLE_API_SETUP_PATH,
  CONSOLE_API_STATE_PATH,
  CONSOLE_API_WHOAMI_PATH,
} from '../../../src/console-api/contract.js'
import { createRemoteClient, type FetchLike, type RemoteIo } from '../../../src/tui/remote/client.js'
import { FAILED_RUN_EXIT_CODE } from '../../../src/tui/run-result.js'

/**
 * The remote console's HTTP client (ADR-0014, plan wave 2 task 2): what it
 * sends, what it accepts back, and — the security property — what it never
 * does with the token no matter how the server misbehaves.
 */

const BASE_URL = 'http://console.invalid'
const SENTINEL_TOKEN = 'mcpa_sentinel-do-not-leak-9f3c1a'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A streaming NDJSON response built from raw chunks, exactly as bytes arrive off a socket. */
function streamResponse(chunks: readonly Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function recordingIo(): RemoteIo & { out(): string; err(): string } {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    out: () => stdout.join(''),
    err: () => stderr.join(''),
  }
}

/** A fetch double that records every call it received. */
function recordingFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetchImpl: FetchLike
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const record = init ?? {}
    calls.push({ url, init: record })
    return handler(url, record)
  }) as FetchLike
  return { fetchImpl, calls }
}

function headerValue(init: RequestInit, name: string): string | undefined {
  const headers = init.headers
  if (headers === undefined) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  if (Array.isArray(headers)) return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  return (headers as Record<string, string>)[name] ?? (headers as Record<string, string>)[name.toLowerCase()]
}

function hasHeader(init: RequestInit, name: string): boolean {
  return headerValue(init, name) !== undefined
}

describe('state', () => {
  test('a 200 with a valid document resolves ok', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(200, { api: 1, firstRun: true }))
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })

    const result = await client.state()

    expect(result).toEqual({ ok: true, value: { api: 1, firstRun: true } })
  })

  test('dials the state path with GET and no body', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, { api: 1, firstRun: false }))
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })

    await client.state()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${BASE_URL}${CONSOLE_API_STATE_PATH}`)
    expect(calls[0]?.init.method).toBe('GET')
    expect(calls[0] !== undefined && hasHeader(calls[0].init, 'origin')).toBe(false)
  })

  test('a network failure never contacting the server is reported, not thrown', async () => {
    const fetchImpl: FetchLike = (async () => {
      throw new Error('ECONNREFUSED')
    }) as FetchLike
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })

    const result = await client.state()

    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe('network')
  })

  test('a document that fails the schema is a network-shaped failure, not a crash', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(200, { nonsense: true }))
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })

    const result = await client.state()

    expect(result.ok).toBe(false)
  })

  test('body that is not JSON at all is a network-shaped failure', async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response('not json', { status: 200 })) as FetchLike
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })

    const result = await client.state()

    expect(result.ok).toBe(false)
  })
})

describe('whoami', () => {
  test('sends the token as Authorization: Bearer, once, and nowhere else', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, { name: 'alice', role: 'owner' }))
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })

    const result = await client.whoami(SENTINEL_TOKEN)

    expect(result).toEqual({ ok: true, value: { name: 'alice', role: 'owner' } })
    expect(calls[0]?.url).toBe(`${BASE_URL}${CONSOLE_API_WHOAMI_PATH}`)
    expect(headerValue(calls[0]!.init, 'authorization')).toBe(`Bearer ${SENTINEL_TOKEN}`)
    expect(hasHeader(calls[0]!.init, 'origin')).toBe(false)
  })

  test('401 answers as a refusal naming the contract error, with the server message', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(401, { error: 'unauthorized', message: 'nope' }),
    )
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })

    const result = await client.whoami('whatever')

    expect(result).toEqual({ ok: false, kind: 'unauthorized', message: 'nope' })
  })

  test('a body claiming 401 but without the error shape is a network-shaped failure', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(401, { oops: true }))
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })

    const result = await client.whoami('whatever')

    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe('network')
  })
})

describe('setup', () => {
  test('posts the code and name, and reports the minted token', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, { name: 'alice', token: 'mcpa_new', journaled: true }),
    )
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })

    const result = await client.setup({ code: 'mcps_abc', name: 'alice' })

    expect(result).toEqual({ ok: true, value: { name: 'alice', token: 'mcpa_new', journaled: true } })
    expect(calls[0]?.url).toBe(`${BASE_URL}${CONSOLE_API_SETUP_PATH}`)
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code: 'mcps_abc', name: 'alice' })
  })

  test('code-refused keeps the server message', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(403, { error: 'code-refused', message: 'wrong code' }),
    )
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })

    const result = await client.setup({ code: 'bad', name: 'alice' })

    expect(result).toEqual({ ok: false, kind: 'code-refused', message: 'wrong code' })
  })
})

describe('run: streaming', () => {
  test('assembles frames split across chunks, including a split multi-byte character', async () => {
    // "café" — the é (U+00E9) encodes to two UTF-8 bytes; split the frame right
    // between them to prove the decoder is stateful across chunks.
    const wholeLine = `${JSON.stringify({ t: 'out', d: 'café' })}\n`
    const bytes = encode(wholeLine)
    const splitPoint = wholeLine.indexOf('caf') + 3 + 1 // one byte into the two-byte é
    const chunks = [bytes.slice(0, splitPoint), bytes.slice(splitPoint), encode(`${JSON.stringify({ t: 'exit', code: 0 })}\n`)]
    const { fetchImpl } = recordingFetch(() => streamResponse(chunks))
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
    const io = recordingIo()

    const code = await client.run({ argv: ['status'] }, 'tok', io)

    expect(io.out()).toBe('café')
    expect(code).toBe(0)
  })

  test('a frame split across two chunks is still parsed as one', async () => {
    const line = `${JSON.stringify({ t: 'out', d: 'hello world' })}\n`
    const bytes = encode(line)
    const mid = Math.floor(bytes.length / 2)
    const chunks = [bytes.slice(0, mid), bytes.slice(mid), encode(`${JSON.stringify({ t: 'exit', code: 0 })}\n`)]
    const { fetchImpl } = recordingFetch(() => streamResponse(chunks))
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
    const io = recordingIo()

    const code = await client.run({ argv: ['status'] }, 'tok', io)

    expect(io.out()).toBe('hello world')
    expect(code).toBe(0)
  })

  test('out and err frames go to their own stream, exit is the return value', async () => {
    const chunks = [
      encode(`${JSON.stringify({ t: 'out', d: 'line one\n' })}\n`),
      encode(`${JSON.stringify({ t: 'err', d: 'a warning\n' })}\n`),
      encode(`${JSON.stringify({ t: 'exit', code: 7 })}\n`),
    ]
    const { fetchImpl } = recordingFetch(() => streamResponse(chunks))
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
    const io = recordingIo()

    const code = await client.run({ argv: ['status'] }, 'tok', io)

    expect(io.out()).toBe('line one\n')
    expect(io.err()).toBe('a warning\n')
    expect(code).toBe(7)
  })

  test('a stream that ends with no exit frame is a failed run, never exit 0', async () => {
    const chunks = [encode(`${JSON.stringify({ t: 'out', d: 'partial' })}\n`)]
    const { fetchImpl } = recordingFetch(() => streamResponse(chunks))
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
    const io = recordingIo()

    const code = await client.run({ argv: ['status'] }, 'tok', io)

    expect(code).toBe(FAILED_RUN_EXIT_CODE)
    expect(code).not.toBe(0)
    expect(io.err()).not.toBe('')
  })

  test('an endless line with no newline fails the run (malformed-frame path) and cancels the body, instead of growing forever', async () => {
    let cancelled = false
    const encoder = new TextEncoder()
    // 64 KiB per pull, never a newline: past the cap in well under 32 pulls —
    // this must terminate quickly, not hang or exhaust memory.
    const CHUNK = 'x'.repeat(64 * 1024)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode(CHUNK))
      },
      cancel() {
        cancelled = true
      },
    })
    const response = new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
    const { fetchImpl } = recordingFetch(() => response)
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
    const io = recordingIo()

    const code = await client.run({ argv: ['status'] }, 'tok', io)

    expect(code).toBe(FAILED_RUN_EXIT_CODE)
    expect(cancelled).toBe(true)
  })

  test('a malformed frame is a failed run', async () => {
    const chunks = [encode('not json at all\n')]
    const { fetchImpl } = recordingFetch(() => streamResponse(chunks))
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
    const io = recordingIo()

    const code = await client.run({ argv: ['status'] }, 'tok', io)

    expect(code).toBe(FAILED_RUN_EXIT_CODE)
  })

  test('a network error mid-request is a failed run', async () => {
    const fetchImpl: FetchLike = (async () => {
      throw new Error('socket hang up')
    }) as FetchLike
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
    const io = recordingIo()

    const code = await client.run({ argv: ['status'] }, 'tok', io)

    expect(code).toBe(FAILED_RUN_EXIT_CODE)
    expect(io.err()).not.toBe('')
  })

  test('non-200 writes the refusal message to stderr and fails the run', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(403, { error: 'forbidden', message: 'no argv like that' }))
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
    const io = recordingIo()

    const code = await client.run({ argv: ['wrap'] }, 'tok', io)

    expect(code).toBe(FAILED_RUN_EXIT_CODE)
    expect(io.err()).toContain('no argv like that')
  })

  test('sends the argv and stdin as the contract body, and the token only in Authorization', async () => {
    const { fetchImpl, calls } = recordingFetch(() => streamResponse([encode(`${JSON.stringify({ t: 'exit', code: 0 })}\n`)]))
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
    const io = recordingIo()

    await client.run({ argv: ['vault', 'set', 'x'], stdin: 'shh' }, SENTINEL_TOKEN, io)

    const call = calls[0]!
    expect(JSON.parse(String(call.init.body))).toEqual({ argv: ['vault', 'set', 'x'], stdin: 'shh' })
    expect(headerValue(call.init, 'authorization')).toBe(`Bearer ${SENTINEL_TOKEN}`)
    expect(hasHeader(call.init, 'origin')).toBe(false)
  })
})

/** Lets already-queued microtasks (the async iterator's own bookkeeping) settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('run: honouring the local sink\'s backpressure (review finding 4)', () => {
  test('a write reporting `false` pauses further frames until the sink drains, then resumes', async () => {
    const drainListeners: Array<() => void> = []
    const writes: string[] = []
    let firstWriteAlreadyStalled = false
    const stdout = {
      write: (chunk: string): boolean => {
        writes.push(chunk)
        if (!firstWriteAlreadyStalled) {
          firstWriteAlreadyStalled = true
          return false
        }
        return true
      },
      once: (event: 'drain', listener: () => void): void => {
        if (event === 'drain') drainListeners.push(listener)
      },
    }
    const io: RemoteIo = { stdout, stderr: { write: () => true } }
    const wholeBody =
      `${JSON.stringify({ t: 'out', d: 'first' })}\n` +
      `${JSON.stringify({ t: 'out', d: 'second' })}\n` +
      `${JSON.stringify({ t: 'exit', code: 0 })}\n`
    const { fetchImpl } = recordingFetch(() => streamResponse([encode(wholeBody)]))
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })

    const running = client.run({ argv: ['status'] }, 'tok', io)
    await tick()
    await tick()

    // The stalled write's frame landed, but nothing past it has — the second
    // frame (already fully buffered, in the SAME chunk) must not be written
    // before the sink says it has drained.
    expect(writes).toEqual(['first'])
    expect(drainListeners).toHaveLength(1)

    drainListeners[0]!()
    const code = await running

    expect(writes).toEqual(['first', 'second'])
    expect(code).toBe(0)
  })

  test('a sink with no `once` (no backpressure signal at all) never parks — unaffected by this change', async () => {
    const io = recordingIo()
    const chunks = [
      encode(`${JSON.stringify({ t: 'out', d: 'a' })}\n${JSON.stringify({ t: 'out', d: 'b' })}\n${JSON.stringify({ t: 'exit', code: 0 })}\n`),
    ]
    const { fetchImpl } = recordingFetch(() => streamResponse(chunks))
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })

    const code = await client.run({ argv: ['status'] }, 'tok', io)

    expect(io.out()).toBe('ab')
    expect(code).toBe(0)
  })
})

describe('run: surfacing the refusal kind to the caller (ADR-0014 HIGH review)', () => {
  test('a structured `unauthorized` refusal is reported through `onRefusal`, without changing what reaches `io`', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(401, { error: 'unauthorized', message: 'nope' }),
    )
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
    const io = recordingIo()
    let seenKind: string | undefined

    const code = await client.run({ argv: ['status'] }, 'tok', io, (kind) => {
      seenKind = kind
    })

    expect(seenKind).toBe('unauthorized')
    expect(code).toBe(FAILED_RUN_EXIT_CODE)
    expect(io.err()).toContain('nope')
  })

  test('a different structured refusal (forbidden) is reported with its own kind, not unauthorized', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(403, { error: 'forbidden', message: 'no argv like that' }),
    )
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
    const io = recordingIo()
    let seenKind: string | undefined

    await client.run({ argv: ['wrap'] }, 'tok', io, (kind) => {
      seenKind = kind
    })

    expect(seenKind).toBe('forbidden')
  })

  test('a network failure (no response at all) never calls `onRefusal`', async () => {
    const fetchImpl: FetchLike = (async () => {
      throw new Error('ECONNREFUSED')
    }) as FetchLike
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
    const io = recordingIo()
    let called = false

    await client.run({ argv: ['status'] }, 'tok', io, () => {
      called = true
    })

    expect(called).toBe(false)
  })

  test('a non-200 response whose body is not the contract error shape is a network-shaped failure and never calls `onRefusal`', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(500, { oops: true }))
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
    const io = recordingIo()
    let called = false

    await client.run({ argv: ['status'] }, 'tok', io, () => {
      called = true
    })

    expect(called).toBe(false)
  })

  test('a successful run (200, any exit code) never calls `onRefusal`', async () => {
    const { fetchImpl } = recordingFetch(() =>
      streamResponse([encode(`${JSON.stringify({ t: 'exit', code: 3 })}\n`)]),
    )
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
    const io = recordingIo()
    let called = false

    const code = await client.run({ argv: ['status'] }, 'tok', io, () => {
      called = true
    })

    expect(code).toBe(3)
    expect(called).toBe(false)
  })

  test('omitting `onRefusal` entirely still behaves exactly as before', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(401, { error: 'unauthorized', message: 'nope' }),
    )
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
    const io = recordingIo()

    const code = await client.run({ argv: ['status'] }, 'tok', io)

    expect(code).toBe(FAILED_RUN_EXIT_CODE)
  })
})

describe('the token never reaches a frame or an error message', () => {
  test('across a battery of failing calls, the sentinel token appears only in the Authorization header', async () => {
    const scenarios: Array<() => Promise<unknown>> = []
    const observedText: string[] = []

    const make = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) =>
      recordingFetch(handler)

    // 1. a thrown network error unrelated to the token (ECONNREFUSED, a DNS
    // failure): the client must not have woven the token into a message of
    // its own construction either.
    {
      const fetchImpl: FetchLike = (async () => {
        throw new Error('ECONNREFUSED')
      }) as FetchLike
      const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
      const io = recordingIo()
      scenarios.push(async () => {
        const code = await client.run({ argv: ['status'] }, SENTINEL_TOKEN, io)
        observedText.push(io.out(), io.err(), String(code))
      })
    }

    // 2. a refusal from the server
    {
      const { fetchImpl } = make(() => jsonResponse(401, { error: 'unauthorized', message: 'no' }))
      const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
      const io = recordingIo()
      scenarios.push(async () => {
        await client.run({ argv: ['status'] }, SENTINEL_TOKEN, io)
        observedText.push(io.out(), io.err())
      })
    }

    // 3. a malformed stream
    {
      const { fetchImpl } = make(() => streamResponse([encode('garbage\n')]))
      const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl })
      const io = recordingIo()
      scenarios.push(async () => {
        await client.run({ argv: ['status'] }, SENTINEL_TOKEN, io)
        observedText.push(io.out(), io.err())
      })
    }

    for (const scenario of scenarios) await scenario()

    expect(observedText.join('\n')).not.toContain(SENTINEL_TOKEN)
  })
})

describe('connect timeout', () => {
  test('a call that never gets a response is aborted after the connect timeout', async () => {
    const fetchImpl: FetchLike = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as FetchLike
    const client = createRemoteClient({ baseUrl: BASE_URL, fetchImpl, connectTimeoutMs: 20 })

    const result = await client.state()

    expect(result.ok).toBe(false)
  })
})
