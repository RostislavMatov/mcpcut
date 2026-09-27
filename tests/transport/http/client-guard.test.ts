import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Agent as HttpsAgent, globalAgent as httpsGlobalAgent } from 'node:https'
import {
  connect as netConnect,
  createServer as createNetServer,
  type AddressInfo,
  type LookupFunction,
  type Server as NetServer,
  type Socket,
} from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createUpstreamGuard,
  UpstreamAddressRefusedError,
  type ResolveAllFunction,
  type UpstreamGuard,
} from '../../../src/net/upstream-guard.js'
import {
  createHttpUpstreamClient,
  SseStreamError,
  UpstreamConnectionError,
  type HttpUpstreamClient,
  type HttpUpstreamClientOptions,
  type HttpUpstreamRecord,
} from '../../../src/transport/http/client.js'
import { clientMessage, type McpMessage, type MessageSource } from '../../../src/transport/message.js'
import { waitUntil, waitUntilAsync } from '../../proxy/harness.js'

/**
 * The tenant-mode SSRF guard inside the HTTP upstream client (ADR-0017 T4,
 * tenant-mode plan Task 5). The guard is optional: a client built without one
 * dials exactly as before, which is what every test in `client.test.ts` pins.
 * Here: with a guard, a refused upstream receives NOTHING — not a request,
 * not even a TCP connection — on every one of the client's three requests
 * (POST, the GET stream, the session DELETE), and the operator reads why.
 */

const SECRET_QUERY = 'token=QUERY-SECRET-MARKER'

const openClients: HttpUpstreamClient[] = []
const openServers: Array<Server | NetServer> = []

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()))
  for (const server of openServers.splice(0)) {
    if ('closeAllConnections' in server) server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function openClient(record: HttpUpstreamRecord, opts: HttpUpstreamClientOptions): HttpUpstreamClient {
  const client = createHttpUpstreamClient(record, opts)
  openClients.push(client)
  return client
}

/** A bare TCP listener that only counts connections: "received nothing" means zero here. */
async function countingListener(): Promise<{ port: number; connections: () => number }> {
  let connections = 0
  const server = createNetServer((socket) => {
    connections += 1
    socket.destroy()
  })
  openServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, connections: () => connections }
}

interface SessionfulServer {
  readonly port: number
  readonly seen: Array<{ method: string; host: string }>
}

/**
 * A minimal sessionful MCP upstream: POST answers JSON with a session id,
 * GET opens an SSE stream and holds it, DELETE answers 200. Records the
 * method and `Host` header of every request it receives.
 */
async function sessionfulServer(): Promise<SessionfulServer> {
  const seen: Array<{ method: string; host: string }> = []
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    seen.push({ method: req.method ?? '', host: req.headers.host ?? '' })
    req.resume()
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders()
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
  }
  const server = createHttpServer(handler)
  openServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, seen }
}

function requestMessage(id: number, method: string): McpMessage {
  return clientMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })))
}

function collectErrors(source: MessageSource): unknown[] {
  const errors: unknown[] = []
  source.onMessage(() => undefined)
  source.onError((error) => errors.push(error))
  source.onEnd(() => undefined)
  return errors
}

/** A resolver that answers every name with one fixed address. */
function resolvingTo(address: string): ResolveAllFunction {
  return (_hostname, _options, callback) => callback(null, [{ address, family: 4 }])
}

/** A lookup that pins every name to 127.0.0.1 (a test stand-in for a public answer). */
const pinToLoopback: LookupFunction = (_hostname, options, callback) => {
  if (options.all === true) {
    callback(null, [{ address: '127.0.0.1', family: 4 }])
    return
  }
  callback(null, '127.0.0.1', 4)
}

/**
 * A stand-in guard for the tests that need a request to PASS first (a real
 * guard never lets anything reach a local test server): it pins every name to
 * 127.0.0.1 and starts refusing once `refuseFrom` checks have passed.
 */
function scriptedGuard(refuseFrom: number): UpstreamGuard & { refuseNow(): void } {
  let checks = 0
  let isRefusing = false
  return {
    checkUrl: (url: URL) => {
      checks += 1
      if (isRefusing || checks >= refuseFrom) {
        throw new UpstreamAddressRefusedError(url.hostname, 'private')
      }
    },
    lookup: pinToLoopback,
    // Never used: these tests dial plain http, and an https.Agent carries only https.
    agent: new HttpsAgent({ keepAlive: true, lookup: pinToLoopback }),
    refuseNow: () => {
      isRefusing = true
    },
  }
}

describe('HTTP upstream client with a guard', () => {
  test('a loopback literal is refused before any connection, with the reason and no path or query', async () => {
    const listener = await countingListener()
    const client = openClient(
      { url: `https://127.0.0.1:${listener.port}/mcp?${SECRET_QUERY}`, protocol: 'stateless' },
      { guard: createUpstreamGuard() },
    )
    const errors = collectErrors(client.source)

    const write = client.sink.write(requestMessage(1, 'tools/list'))

    await expect(write).rejects.toBeInstanceOf(UpstreamAddressRefusedError)
    const error = errors[0] as UpstreamAddressRefusedError
    expect(error).toBeInstanceOf(UpstreamAddressRefusedError)
    expect(error.message).toBe(
      'refused to connect to 127.0.0.1: it is a loopback address; ' +
        'this install reaches only public https servers (tenant mode)',
    )
    expect(error.message).not.toContain('/mcp')
    expect(error.message).not.toContain('QUERY-SECRET-MARKER')
    expect(listener.connections()).toBe(0)
  })

  test('a name that resolves to loopback is refused inside the socket lookup — no connection, no address shown', async () => {
    const listener = await countingListener()
    const guard = createUpstreamGuard({ lookup: resolvingTo('127.0.0.1') })
    // No explicit port: since ADR-0017 O8 the guard's own `checkUrl` refuses
    // any non-443 port before a request is even built, and this test is about
    // the LATER refusal inside DNS resolution — `listener` exists only to
    // prove no TCP connection ever happens, whatever port the URL names.
    const client = openClient(
      { url: `https://upstream.test/mcp?${SECRET_QUERY}`, protocol: 'stateless' },
      { guard },
    )
    const errors = collectErrors(client.source)

    await expect(client.sink.write(requestMessage(1, 'tools/list'))).rejects.toBeInstanceOf(
      UpstreamAddressRefusedError,
    )
    const error = errors[0] as Error
    expect(error.message).toContain('refused to connect to upstream.test: it resolves to a loopback address')
    expect(error.message).not.toContain('127.0.0.1')
    expect(error.message).not.toContain('QUERY-SECRET-MARKER')
    expect(listener.connections()).toBe(0)
  })

  test('plain http is refused by scheme before any connection', async () => {
    const listener = await countingListener()
    const client = openClient(
      { url: `http://127.0.0.1:${listener.port}/mcp`, protocol: 'stateless' },
      { guard: createUpstreamGuard() },
    )
    collectErrors(client.source)

    await expect(client.sink.write(requestMessage(1, 'tools/list'))).rejects.toThrow(
      'this install reaches only https servers (tenant mode)',
    )
    expect(listener.connections()).toBe(0)
  })

  test('an https url naming a non-443 port is refused by the guard before any connection (O8)', async () => {
    const listener = await countingListener()
    const client = openClient(
      { url: `https://upstream.test:${listener.port}/mcp`, protocol: 'stateless' },
      { guard: createUpstreamGuard() },
    )
    collectErrors(client.source)

    await expect(client.sink.write(requestMessage(1, 'tools/list'))).rejects.toThrow(
      'this install reaches only port 443 (tenant mode)',
    )
    expect(listener.connections()).toBe(0)
  })

  test('the socket dials the address the guard handed out, and Host still names the record host', async () => {
    const upstream = await sessionfulServer()
    const client = openClient(
      { url: `http://pinned.test:${upstream.port}/mcp`, protocol: 'stateless' },
      { guard: scriptedGuard(Number.POSITIVE_INFINITY) },
    )
    collectErrors(client.source)

    await client.sink.write(requestMessage(1, 'tools/list'))

    // `pinned.test` does not resolve anywhere; only the guard's lookup can have
    // produced the socket that reached this server.
    expect(upstream.seen).toEqual([{ method: 'POST', host: `pinned.test:${upstream.port}` }])
  })

  test('the GET stream is refused too — reported at once as the refusal, not retried into SseStreamError', async () => {
    const upstream = await sessionfulServer()
    // Check 1 is the POST; check 2, the GET stream it opens, is refused.
    const client = openClient(
      { url: `http://pinned.test:${upstream.port}/mcp`, protocol: 'sessionful' },
      { guard: scriptedGuard(2), sseReconnectMaxAttempts: 3, delay: () => Promise.resolve() },
    )
    const errors = collectErrors(client.source)

    await client.sink.write(requestMessage(1, 'initialize'))
    await waitUntil(() => errors.length > 0)

    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(UpstreamAddressRefusedError)
    expect(errors[0]).not.toBeInstanceOf(SseStreamError)
    expect(upstream.seen.map((request) => request.method)).toEqual(['POST'])
  })

  test('the session DELETE is refused too — the upstream never sees it, the refusal is reported', async () => {
    const upstream = await sessionfulServer()
    const guard = scriptedGuard(Number.POSITIVE_INFINITY)
    const client = openClient(
      { url: `http://pinned.test:${upstream.port}/mcp`, protocol: 'sessionful' },
      { guard },
    )
    const errors = collectErrors(client.source)
    await client.sink.write(requestMessage(1, 'initialize'))
    await waitUntilAsync(() => Promise.resolve(upstream.seen.some((request) => request.method === 'GET')))

    guard.refuseNow()
    await client.close()

    expect(upstream.seen.map((request) => request.method)).toEqual(['POST', 'GET'])
    expect(errors.some((error) => error instanceof UpstreamAddressRefusedError)).toBe(true)
  })
})

/**
 * Security review M1: a guarded request dials through the guard's own socket
 * pool. The process-wide keep-alive `https.globalAgent` (Node 19+) may hold a
 * socket some unguarded client opened to the same host:port; handed that
 * socket, the request would never resolve again, so the guard's lookup would
 * never run and a refused address would get the request anyway.
 */
describe('HTTP upstream client with a guard — its own socket pool', () => {
  /** A listener that answers any bytes with a 500, recording what arrived. */
  async function recordingListener(): Promise<{ port: number; received: () => string }> {
    let received = ''
    const server = createNetServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('latin1')
        socket.end('HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\n\r\n')
      })
    })
    openServers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { port: (server.address() as AddressInfo).port, received: () => received }
  }

  test('a keep-alive socket the global https agent already holds for the same host is never reused', async () => {
    const listener = await recordingListener()
    const planted: Socket = netConnect(listener.port, '127.0.0.1')
    await new Promise<void>((resolve) => planted.once('connect', () => resolve()))
    const freeSockets = httpsGlobalAgent.freeSockets as Record<string, Socket[] | undefined>
    // No explicit port on the client's own URL below (ADR-0017 O8: the guard
    // refuses any non-443 port before dialing), so the pool key it would
    // collide on is the default https port — `listener`'s real port is only
    // where `planted` physically connects, to prove NOTHING flows to it.
    const name = httpsGlobalAgent.getName({ host: 'upstream.test', port: 443 })
    freeSockets[name] = [planted]
    try {
      const client = openClient(
        { url: 'https://upstream.test/mcp', protocol: 'stateless' },
        { guard: createUpstreamGuard({ lookup: resolvingTo('127.0.0.1') }) },
      )
      collectErrors(client.source)

      const write = client.sink.write(requestMessage(1, 'tools/list'))

      await expect(write).rejects.toBeInstanceOf(UpstreamAddressRefusedError)
      expect(listener.received()).toBe('')
    } finally {
      delete freeSockets[name]
      planted.destroy()
    }
  })

  test('the request is dialed by the guard agent, never by the global one', async () => {
    const listener = await countingListener()
    const guard = createUpstreamGuard({ lookup: resolvingTo('127.0.0.1') })
    const viaGlobal = vi.spyOn(httpsGlobalAgent, 'createConnection')
    const viaGuard = vi.spyOn(guard.agent, 'createConnection')
    try {
      // No explicit port (ADR-0017 O8) — `listener` only proves no TCP
      // connection is ever made, whatever port a real one would have used.
      const client = openClient(
        { url: 'https://upstream.test/mcp', protocol: 'stateless' },
        { guard },
      )
      collectErrors(client.source)

      await expect(client.sink.write(requestMessage(1, 'tools/list'))).rejects.toBeInstanceOf(
        UpstreamAddressRefusedError,
      )
      expect(viaGlobal).not.toHaveBeenCalled()
      expect(viaGuard).toHaveBeenCalledTimes(1)
      expect(listener.connections()).toBe(0)
    } finally {
      viaGlobal.mockRestore()
      viaGuard.mockRestore()
    }
  })
})

describe('HTTP upstream client without a guard (unchanged)', () => {
  test('the same loopback listener is dialed, and a failure is still an UpstreamConnectionError', async () => {
    const listener = await countingListener()
    const client = openClient({ url: `http://127.0.0.1:${listener.port}/mcp`, protocol: 'stateless' }, {})
    collectErrors(client.source)

    await expect(client.sink.write(requestMessage(1, 'tools/list'))).rejects.toBeInstanceOf(
      UpstreamConnectionError,
    )
    expect(listener.connections()).toBe(1)
  })
})
