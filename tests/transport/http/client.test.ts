import { spawn, type ChildProcess } from 'node:child_process'
import { request as nodeHttpRequest } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { clientMessage, type McpMessage, type MessageSource } from '../../../src/transport/message.js'
import {
  createHttpUpstreamClient,
  SessionExpiredError,
  SseStreamError,
  UpstreamConnectionError,
  UpstreamHttpStatusError,
  type HttpUpstreamClient,
  type HttpUpstreamClientOptions,
  type HttpUpstreamRecord,
} from '../../../src/transport/http/client.js'
import { createSseParser, SseParseError } from '../../../src/transport/http/sse-parse.js'
import { waitUntil, waitUntilAsync } from '../../proxy/harness.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SESSIONFUL_FIXTURE = join(__dirname, '../../fixtures/http-server-sessionful.mjs')
const STATELESS_FIXTURE = join(__dirname, '../../fixtures/http-server-stateless.mjs')

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HttpCallResult {
  readonly status: number
  readonly body: string
}

/** Raw HTTP call for driving fixture control endpoints (node:http only). */
function httpCall(method: string, target: string, body?: string): Promise<HttpCallResult> {
  return new Promise((resolve, reject) => {
    const req = nodeHttpRequest(target, { method }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('error', reject)
    req.end(body)
  })
}

interface FixtureStats {
  readonly posts: number
  readonly getRequests: number
  readonly deletes: number
  readonly lastPostHeaders: Record<string, string> | null
  readonly sessions?: string[]
  readonly openGetStreams?: number
}

interface Fixture {
  readonly mcpUrl: string
  stats(): Promise<FixtureStats>
  emit(body: string, retryMs?: number): Promise<void>
  expire(): Promise<void>
  dropGet(): Promise<void>
  stop(): Promise<void>
}

const spawnedFixtures: ChildProcess[] = []

/** Spawns a fixture server as its own process and reads the port off stdout line 1. */
async function startFixture(file: string, env: Record<string, string> = {}): Promise<Fixture> {
  const child = spawn(process.execPath, [file], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  spawnedFixtures.push(child)
  const port = await new Promise<number>((resolve, reject) => {
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const newlineIndex = out.indexOf('\n')
      if (newlineIndex !== -1) {
        resolve(Number(out.slice(0, newlineIndex)))
      }
    })
    child.on('error', reject)
    child.on('exit', (code) => reject(new Error(`fixture exited before printing a port: ${code}`)))
  })
  const base = `http://127.0.0.1:${port}`

  return {
    mcpUrl: `${base}/mcp`,
    stats: async () => JSON.parse((await httpCall('GET', `${base}/__control/stats`)).body) as FixtureStats,
    emit: async (body: string, retryMs?: number) => {
      const query = retryMs === undefined ? '' : `?retry=${retryMs}`
      await httpCall('POST', `${base}/__control/emit${query}`, body)
    },
    expire: async () => {
      await httpCall('POST', `${base}/__control/expire`)
    },
    dropGet: async () => {
      await httpCall('POST', `${base}/__control/drop-get`)
    },
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill('SIGKILL')
      }),
  }
}

/** A localhost port with nothing listening on it (connection-refused tests). */
async function refusedPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

interface Collector {
  readonly raw: McpMessage[]
  readonly messages: Array<Record<string, unknown>>
  readonly errors: unknown[]
  endedCount: number
}

function collect(source: MessageSource): Collector {
  const collector: Collector = { raw: [], messages: [], errors: [], endedCount: 0 }
  source.onMessage((message) => {
    collector.raw.push(message)
    collector.messages.push(JSON.parse(message.bytes.toString('utf8')) as Record<string, unknown>)
  })
  source.onError((error) => collector.errors.push(error))
  source.onEnd(() => {
    collector.endedCount += 1
  })
  return collector
}

const openClients: HttpUpstreamClient[] = []

function openClient(record: HttpUpstreamRecord, opts?: HttpUpstreamClientOptions): HttpUpstreamClient {
  const client = createHttpUpstreamClient(record, opts)
  openClients.push(client)
  return client
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()))
  for (const child of spawnedFixtures.splice(0)) {
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill('SIGKILL')
      })
    }
  }
})

function record(url: string, protocol: HttpUpstreamRecord['protocol'], headers?: Record<string, string>): HttpUpstreamRecord {
  return { url, protocol, ...(headers !== undefined ? { headers } : {}) }
}

function requestMessage(id: number, method: string): McpMessage {
  return clientMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })))
}

function notificationMessage(method: string): McpMessage {
  return clientMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params: {} })))
}

/** Injected instant timer that records every requested wait. */
function recordingDelay(): { delays: number[]; delay: (ms: number) => Promise<void> } {
  const delays: number[] = []
  return {
    delays,
    delay: (ms: number) => {
      delays.push(ms)
      return Promise.resolve()
    },
  }
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

describe('createSseParser', () => {
  test('joins multi-line data with \\n, ignores event/id/comments, surfaces retry', () => {
    const parser = createSseParser()

    const items = parser.feed(
      Buffer.from(': hello\nretry: 1500\nevent: message\nid: 7\ndata: line-1\ndata: line-2\n\n'),
    )

    expect(items).toEqual([
      { kind: 'retry', retryMs: 1500 },
      { kind: 'message', data: 'line-1\nline-2' },
    ])
  })

  test('reassembles events split across arbitrary chunk boundaries (CRLF, multibyte)', () => {
    const parser = createSseParser()
    const wire = Buffer.from('data: café \u{1f389}\r\ndata: two\r\n\r\n')

    const items: unknown[] = []
    for (const byte of wire) {
      items.push(...parser.feed(Buffer.from([byte])))
    }

    expect(items).toEqual([{ kind: 'message', data: 'café \u{1f389}\ntwo' }])
  })

  test('an event with no data (2025-11-25 priming shape: id + empty data) dispatches nothing', () => {
    const parser = createSseParser()

    const items = parser.feed(Buffer.from('id: prime\ndata\n\n'))

    expect(items).toEqual([])
    expect(parser.end()).toEqual([])
  })

  test('end() throws SseParseError when the stream is truncated mid-event', () => {
    const parser = createSseParser()
    parser.feed(Buffer.from('data: half an eve'))

    expect(() => parser.end()).toThrow(SseParseError)
  })
})

// ---------------------------------------------------------------------------
// Sessionful upstream
// ---------------------------------------------------------------------------

describe('sessionful upstream', () => {
  test('happy path: initialize response arrives, session id is captured and sent on later POSTs', async () => {
    const fixture = await startFixture(SESSIONFUL_FIXTURE)
    const client = openClient(record(fixture.mcpUrl, 'sessionful'))
    const collector = collect(client.source)

    await client.sink.write(requestMessage(1, 'initialize'))
    await client.sink.write(requestMessage(2, 'tools/list'))

    expect(collector.errors).toEqual([])
    expect(collector.messages).toHaveLength(2)
    expect(collector.messages[1]?.['id']).toBe(2)
    const stats = await fixture.stats()
    const sessionId = stats.sessions?.[0]
    expect(sessionId).toBeTruthy()
    expect((collector.messages[1]?.['result'] as { sessionId: string }).sessionId).toBe(sessionId)
    expect(stats.lastPostHeaders?.['mcp-session-id']).toBe(sessionId)
    // Emitted messages are server-origin and carry no stdio terminator key.
    expect(collector.raw[0]?.meta.origin).toBe('server')
    expect(collector.raw[0] !== undefined && 'terminator' in collector.raw[0].meta).toBe(false)
  })

  test('a notification is answered 202 with no body: write resolves, nothing is emitted', async () => {
    const fixture = await startFixture(SESSIONFUL_FIXTURE)
    const client = openClient(record(fixture.mcpUrl, 'sessionful'))
    const collector = collect(client.source)
    await client.sink.write(requestMessage(1, 'initialize'))

    await client.sink.write(notificationMessage('notifications/initialized'))

    expect(collector.messages).toHaveLength(1)
    expect(collector.errors).toEqual([])
  })

  test('server-initiated messages arrive through the GET-SSE stream, multi-line data joined', async () => {
    const fixture = await startFixture(SESSIONFUL_FIXTURE)
    const client = openClient(record(fixture.mcpUrl, 'sessionful'))
    const collector = collect(client.source)
    await client.sink.write(requestMessage(1, 'initialize'))
    await waitUntilAsync(async () => ((await fixture.stats()).openGetStreams ?? 0) >= 1)

    const singleLine = '{"jsonrpc":"2.0","method":"notifications/ping","params":{}}'
    await fixture.emit(singleLine)
    await waitUntil(() => collector.messages.length >= 2)
    const multiLine = 'line-one\nline-two\nline-three'
    await fixture.emit(multiLine)
    await waitUntil(() => collector.raw.length >= 3)

    expect(collector.raw[1]?.bytes.toString('utf8')).toBe(singleLine)
    expect(collector.raw[2]?.bytes.toString('utf8')).toBe(multiLine)
    expect(collector.raw[2]?.meta.origin).toBe('server')
    expect(collector.errors).toEqual([])
  })

  test("protocol 'auto' pins sessionful when the first response carries Mcp-Session-Id", async () => {
    const fixture = await startFixture(SESSIONFUL_FIXTURE)
    const client = openClient(record(fixture.mcpUrl, 'auto'))
    const collector = collect(client.source)

    await client.sink.write(requestMessage(1, 'initialize'))
    await client.sink.write(requestMessage(2, 'tools/list'))

    const result = collector.messages[1]?.['result'] as { sessionId: string | null }
    expect(result.sessionId).not.toBeNull()
    await waitUntilAsync(async () => ((await fixture.stats()).getRequests ?? 0) >= 1)
  })

  test("protocol 'stateless' never adopts a session id the server offers (no header sent, no GET opened)", async () => {
    const fixture = await startFixture(SESSIONFUL_FIXTURE)
    const client = openClient(record(fixture.mcpUrl, 'stateless'))
    const collector = collect(client.source)

    await client.sink.write(requestMessage(1, 'initialize'))
    // The sessionful fixture requires the session header -> 400 proves it was never sent.
    await expect(client.sink.write(requestMessage(2, 'tools/list'))).rejects.toBeInstanceOf(
      UpstreamHttpStatusError,
    )

    const stats = await fixture.stats()
    expect(stats.getRequests).toBe(0)
    expect(stats.lastPostHeaders?.['mcp-session-id']).toBeUndefined()
    expect(collector.errors).toHaveLength(1)
  })

  test("a sessionful server that mints no session id is valid: client works without one", async () => {
    const fixture = await startFixture(SESSIONFUL_FIXTURE, { NO_SESSION: '1' })
    const client = openClient(record(fixture.mcpUrl, 'sessionful'))
    const collector = collect(client.source)

    await client.sink.write(requestMessage(1, 'initialize'))
    await client.sink.write(requestMessage(2, 'tools/list'))

    expect(collector.messages).toHaveLength(2)
    expect(collector.errors).toEqual([])
    const stats = await fixture.stats()
    expect(stats.getRequests).toBe(0)
    expect(stats.lastPostHeaders?.['mcp-session-id']).toBeUndefined()
  })

  test('GET answered 405 means "no server-initiated stream": valid, silent, POSTs unaffected', async () => {
    const fixture = await startFixture(SESSIONFUL_FIXTURE, { GET_UNSUPPORTED: '1' })
    const client = openClient(record(fixture.mcpUrl, 'sessionful'))
    const collector = collect(client.source)

    await client.sink.write(requestMessage(1, 'initialize'))
    await waitUntilAsync(async () => ((await fixture.stats()).getRequests ?? 0) >= 1)
    await client.sink.write(requestMessage(2, 'tools/list'))

    expect(collector.messages).toHaveLength(2)
    expect(collector.errors).toEqual([])
    expect((await fixture.stats()).getRequests).toBe(1)
  })

  test('the GET stream reconnects after a hard drop and keeps delivering', async () => {
    const fixture = await startFixture(SESSIONFUL_FIXTURE)
    const timer = recordingDelay()
    const client = openClient(record(fixture.mcpUrl, 'sessionful'), { delay: timer.delay })
    const collector = collect(client.source)
    await client.sink.write(requestMessage(1, 'initialize'))
    await waitUntilAsync(async () => ((await fixture.stats()).openGetStreams ?? 0) >= 1)

    await fixture.dropGet()
    await waitUntilAsync(async () => ((await fixture.stats()).openGetStreams ?? 0) >= 1)
    await fixture.emit('after-reconnect')
    await waitUntil(() => collector.raw.length >= 2)

    expect(collector.raw[1]?.bytes.toString('utf8')).toBe('after-reconnect')
    expect(timer.delays.length).toBeGreaterThanOrEqual(1)
    expect(collector.errors).toEqual([])
  })

  test("an SSE retry field raises the reconnect delay floor (client MUST honor it)", async () => {
    const fixture = await startFixture(SESSIONFUL_FIXTURE)
    const timer = recordingDelay()
    const client = openClient(record(fixture.mcpUrl, 'sessionful'), { delay: timer.delay })
    const collector = collect(client.source)
    await client.sink.write(requestMessage(1, 'initialize'))
    await waitUntilAsync(async () => ((await fixture.stats()).openGetStreams ?? 0) >= 1)

    await fixture.emit('with-retry', 5000)
    await waitUntil(() => collector.raw.length >= 2)
    await fixture.dropGet()
    await waitUntil(() => timer.delays.length >= 1)

    expect(timer.delays[0]).toBeGreaterThanOrEqual(5000)
  })

  test('reconnect attempts are bounded: exhaustion surfaces one typed SseStreamError', async () => {
    const fixture = await startFixture(SESSIONFUL_FIXTURE, { GET_FAIL: 'always' })
    const timer = recordingDelay()
    const client = openClient(record(fixture.mcpUrl, 'sessionful'), {
      delay: timer.delay,
      sseReconnectMaxAttempts: 3,
    })
    const collector = collect(client.source)

    await client.sink.write(requestMessage(1, 'initialize'))
    await waitUntil(() => collector.errors.length >= 1)

    expect(collector.errors[0]).toBeInstanceOf(SseStreamError)
    expect(timer.delays).toHaveLength(3)
  })

  test('a 404 on an active session is a typed SessionExpiredError, not a hang or silent retry', async () => {
    const fixture = await startFixture(SESSIONFUL_FIXTURE)
    const client = openClient(record(fixture.mcpUrl, 'sessionful'))
    const collector = collect(client.source)
    await client.sink.write(requestMessage(1, 'initialize'))

    await fixture.expire()
    await expect(client.sink.write(requestMessage(2, 'tools/list'))).rejects.toBeInstanceOf(
      SessionExpiredError,
    )

    expect(collector.errors[0]).toBeInstanceOf(SessionExpiredError)
    expect((collector.errors[0] as Error).message).toContain('session expired')
    // Only one POST outcome for id 2: the typed error, no silent re-init.
    expect((await fixture.stats()).posts).toBe(2)
  })

  test('close() DELETEs the session, ends the source, and turns later writes into no-ops', async () => {
    const fixture = await startFixture(SESSIONFUL_FIXTURE)
    const client = openClient(record(fixture.mcpUrl, 'sessionful'))
    const collector = collect(client.source)
    await client.sink.write(requestMessage(1, 'initialize'))
    const postsBefore = (await fixture.stats()).posts

    await client.close()
    await client.close() // idempotent
    await client.sink.write(requestMessage(9, 'tools/list')) // must resolve as a no-op

    const stats = await fixture.stats()
    expect(stats.deletes).toBe(1)
    expect(stats.posts).toBe(postsBefore)
    expect(collector.endedCount).toBe(1)
    expect(collector.errors).toEqual([])
  })

  test('a 405 on DELETE is valid: close() still resolves cleanly', async () => {
    const fixture = await startFixture(SESSIONFUL_FIXTURE, { DELETE_UNSUPPORTED: '1' })
    const client = openClient(record(fixture.mcpUrl, 'sessionful'))
    const collector = collect(client.source)
    await client.sink.write(requestMessage(1, 'initialize'))

    await client.close()

    expect((await fixture.stats()).deletes).toBe(1)
    expect(collector.errors).toEqual([])
  })

  test('sink.dispose() triggers the same shutdown without requiring an await', async () => {
    const fixture = await startFixture(SESSIONFUL_FIXTURE)
    const client = openClient(record(fixture.mcpUrl, 'sessionful'))
    await client.sink.write(requestMessage(1, 'initialize'))

    client.sink.dispose()

    await waitUntilAsync(async () => (await fixture.stats()).deletes >= 1)
  })
})

// ---------------------------------------------------------------------------
// Stateless upstream
// ---------------------------------------------------------------------------

describe('stateless upstream', () => {
  test('happy path: request answered with a JSON body, notification with 202', async () => {
    const fixture = await startFixture(STATELESS_FIXTURE)
    const client = openClient(record(fixture.mcpUrl, 'stateless'))
    const collector = collect(client.source)

    await client.sink.write(requestMessage(1, 'tools/list'))
    await client.sink.write(notificationMessage('notifications/progress'))

    expect(collector.messages).toHaveLength(1)
    expect(collector.messages[0]?.['id']).toBe(1)
    expect((collector.messages[0]?.['result'] as { echo: string }).echo).toBe('tools/list')
    expect(collector.errors).toEqual([])
  })

  test("protocol 'auto' pins stateless when the first response has no session header", async () => {
    const fixture = await startFixture(STATELESS_FIXTURE)
    const client = openClient(record(fixture.mcpUrl, 'auto'))
    const collector = collect(client.source)

    await client.sink.write(requestMessage(1, 'tools/list'))
    await client.sink.write(requestMessage(2, 'tools/list'))

    expect(collector.errors).toEqual([])
    const stats = await fixture.stats()
    expect(stats.lastPostHeaders?.['mcp-session-id']).toBeUndefined()
  })

  test('protocolVersionHeader is sent verbatim on every POST; absent by default', async () => {
    const fixture = await startFixture(STATELESS_FIXTURE)
    const bare = openClient(record(fixture.mcpUrl, 'stateless'))
    collect(bare.source)
    await bare.sink.write(requestMessage(1, 'tools/list'))
    expect((await fixture.stats()).lastPostHeaders?.['mcp-protocol-version']).toBeUndefined()

    const versioned = openClient(record(fixture.mcpUrl, 'stateless'), {
      protocolVersionHeader: '2026-07-28',
    })
    const collector = collect(versioned.source)
    await versioned.sink.write(requestMessage(2, 'tools/list'))

    const received = (collector.messages[0]?.['result'] as { receivedHeaders: Record<string, string | null> })
      .receivedHeaders
    expect(received['mcp-protocol-version']).toBe('2026-07-28')
  })

  test('the injected perMessageHeaders hook supplies Mcp-Method; the default sends none', async () => {
    const fixture = await startFixture(STATELESS_FIXTURE)
    const hookless = openClient(record(fixture.mcpUrl, 'stateless'))
    const hooklessCollector = collect(hookless.source)
    await hookless.sink.write(requestMessage(1, 'tools/call'))

    const hooked = openClient(record(fixture.mcpUrl, 'stateless'), {
      // The hook owns the semantics (Task 11); the transport just forwards it.
      perMessageHeaders: (bytes) => ({
        'mcp-method': (JSON.parse(bytes.toString('utf8')) as { method: string }).method,
      }),
    })
    const hookedCollector = collect(hooked.source)
    await hooked.sink.write(requestMessage(2, 'tools/call'))

    const hooklessHeaders = (
      hooklessCollector.messages[0]?.['result'] as { receivedHeaders: Record<string, string | null> }
    ).receivedHeaders
    const hookedHeaders = (
      hookedCollector.messages[0]?.['result'] as { receivedHeaders: Record<string, string | null> }
    ).receivedHeaders
    expect(hooklessHeaders['mcp-method']).toBeNull()
    expect(hookedHeaders['mcp-method']).toBe('tools/call')
  })

  test('a header/body mismatch is the server’s call: its 400 surfaces as a typed status error', async () => {
    const fixture = await startFixture(STATELESS_FIXTURE)
    const client = openClient(record(fixture.mcpUrl, 'stateless'), {
      perMessageHeaders: () => ({ 'mcp-method': 'not-the-real-method' }),
    })
    const collector = collect(client.source)

    await expect(client.sink.write(requestMessage(1, 'tools/call'))).rejects.toBeInstanceOf(
      UpstreamHttpStatusError,
    )

    expect((collector.errors[0] as UpstreamHttpStatusError).status).toBe(400)
  })

  test('an SSE-bodied POST response delivers every event, in order', async () => {
    const fixture = await startFixture(STATELESS_FIXTURE, { SSE_RESPONSE: '1' })
    const client = openClient(record(fixture.mcpUrl, 'stateless'))
    const collector = collect(client.source)

    await client.sink.write(requestMessage(1, 'tools/call'))

    expect(collector.messages).toHaveLength(2)
    expect(collector.messages[0]?.['method']).toBe('notifications/message')
    expect(collector.messages[1]?.['id']).toBe(1)
    expect(collector.errors).toEqual([])
  })

  test('a non-2xx answer is a typed error naming only status and host — never path or query', async () => {
    const fixture = await startFixture(STATELESS_FIXTURE, { BOOM: '1' })
    const client = openClient(record(`${fixture.mcpUrl}?secret=SHOULD-NOT-LEAK`, 'stateless'))
    const collector = collect(client.source)

    await expect(client.sink.write(requestMessage(1, 'tools/list'))).rejects.toBeInstanceOf(
      UpstreamHttpStatusError,
    )

    const error = collector.errors[0] as UpstreamHttpStatusError
    expect(error.status).toBe(500)
    expect(error.message).toContain('500')
    expect(error.message).toContain('127.0.0.1')
    expect(error.message).not.toContain('SHOULD-NOT-LEAK')
    expect(error.message).not.toContain('/mcp')
  })

  test('connection refused is a typed UpstreamConnectionError with the cause attached', async () => {
    const port = await refusedPort()
    const client = openClient(record(`http://127.0.0.1:${port}/mcp`, 'stateless'))
    const collector = collect(client.source)

    await expect(client.sink.write(requestMessage(1, 'tools/list'))).rejects.toBeInstanceOf(
      UpstreamConnectionError,
    )

    const error = collector.errors[0] as UpstreamConnectionError
    expect(error.message).toContain('ECONNREFUSED')
    expect(error.cause).toBeInstanceOf(Error)
  })

  test('marker: a secret registry header value never appears in error message or stack', async () => {
    const marker = 'SECRET-HEADER-MARKER-XYZ'
    const port = await refusedPort()
    const refused = openClient(
      record(`http://127.0.0.1:${port}/mcp`, 'stateless', { authorization: `Bearer ${marker}` }),
    )
    const refusedCollector = collect(refused.source)
    await expect(refused.sink.write(requestMessage(1, 'tools/list'))).rejects.toBeInstanceOf(Error)

    const fixture = await startFixture(STATELESS_FIXTURE, { BOOM: '1' })
    const boomed = openClient(
      record(fixture.mcpUrl, 'stateless', { authorization: `Bearer ${marker}` }),
    )
    const boomedCollector = collect(boomed.source)
    await expect(boomed.sink.write(requestMessage(2, 'tools/list'))).rejects.toBeInstanceOf(Error)

    for (const error of [...refusedCollector.errors, ...boomedCollector.errors] as Error[]) {
      expect(error.message).not.toContain(marker)
      expect(error.stack ?? '').not.toContain(marker)
      expect(String((error.cause as Error | undefined)?.message ?? '')).not.toContain(marker)
    }
  })

  test('the client surface is frozen (source, sink, container)', async () => {
    const fixture = await startFixture(STATELESS_FIXTURE)
    const client = openClient(record(fixture.mcpUrl, 'stateless'))

    expect(Object.isFrozen(client)).toBe(true)
    expect(Object.isFrozen(client.source)).toBe(true)
    expect(Object.isFrozen(client.sink)).toBe(true)
  })
})
