import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import {
  createHttpUpstreamClient,
  SessionExpiredError,
  UpstreamHttpStatusError,
  type HttpUpstreamClient,
  type HttpUpstreamClientOptions,
  type HttpUpstreamRecord,
} from '../../../src/transport/http/client.js'
import { clientMessage, type McpMessage } from '../../../src/transport/message.js'

/**
 * `deliverErrorBodies` (RV4): a 2026-07-28 server answers a method-level
 * error with a 4xx STATUS and a JSON-RPC body (`404 -32601`, `400 -32602`).
 * Without the flag every non-2xx ends the client — one member without prompts
 * would fall out of a pool on every `prompts/list`. The transport still parses
 * nothing: it looks only at the status and the `content-type`.
 */

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void

const clients: HttpUpstreamClient[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function serve(handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    req.on('end', () => handler(req, res, body))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
}

function open(url: string, protocol: HttpUpstreamRecord['protocol'], opts: HttpUpstreamClientOptions = {}) {
  const client = createHttpUpstreamClient({ url, protocol }, opts)
  clients.push(client)
  const messages: string[] = []
  const errors: unknown[] = []
  client.source.onMessage((message) => messages.push(message.bytes.toString('utf8')))
  client.source.onError((error) => errors.push(error))
  client.source.onEnd(() => undefined)
  return { client, messages, errors }
}

function request(id: number, method: string): McpMessage {
  return clientMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })))
}

function jsonError(res: ServerResponse, status: number, id: unknown, code: number): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: 'no' } }))
}

describe('with deliverErrorBodies', () => {
  test('a 400 with a JSON body arrives as a message, and the client lives on', async () => {
    // Arrange
    const url = await serve((_req, res, body) => {
      const id = (JSON.parse(body) as { id: number }).id
      if (id === 1) jsonError(res, 400, id, -32602)
      else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }))
      }
    })
    const { client, messages, errors } = open(url, 'stateless', { deliverErrorBodies: true })

    // Act
    await client.sink.write(request(1, 'tools/list'))
    await client.sink.write(request(2, 'tools/list'))

    // Assert
    expect(messages.map((line) => (JSON.parse(line) as { id: number }).id)).toEqual([1, 2])
    expect(messages[0]).toContain('-32602')
    expect(errors).toEqual([])
  })

  test('a 404 with a JSON body and no session is a message too', async () => {
    const url = await serve((_req, res, body) => jsonError(res, 404, (JSON.parse(body) as { id: number }).id, -32601))
    const { client, messages, errors } = open(url, 'stateless', { deliverErrorBodies: true })

    await client.sink.write(request(1, 'prompts/list'))

    expect(messages[0]).toContain('-32601')
    expect(errors).toEqual([])
  })

  test('a 400 with an empty body is still an error', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(400)
      res.end()
    })
    const { client, errors } = open(url, 'stateless', { deliverErrorBodies: true })

    await expect(client.sink.write(request(1, 'tools/list'))).rejects.toBeInstanceOf(UpstreamHttpStatusError)
    expect(errors[0]).toBeInstanceOf(UpstreamHttpStatusError)
  })

  test('a 400 with a body that is not JSON is still an error', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(400, { 'content-type': 'text/html' })
      res.end('<h1>no</h1>')
    })
    const { client } = open(url, 'stateless', { deliverErrorBodies: true })

    await expect(client.sink.write(request(1, 'tools/list'))).rejects.toBeInstanceOf(UpstreamHttpStatusError)
  })

  test('a 404 on a LIVE session still means the session expired', async () => {
    // Arrange
    let calls = 0
    const url = await serve((req, res, body) => {
      calls += 1
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      const id = (JSON.parse(body) as { id: number }).id
      if (calls === 1) {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's-1' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }))
        return
      }
      jsonError(res, 404, id, -32601)
    })
    const { client } = open(url, 'sessionful', { deliverErrorBodies: true })
    await client.sink.write(request(1, 'initialize'))

    // Act / Assert
    await expect(client.sink.write(request(2, 'tools/list'))).rejects.toBeInstanceOf(SessionExpiredError)
  })

  test('`auto`: a 400 on the detector pins nothing, and the next 200 without a session pins stateless', async () => {
    // Arrange
    const sessionHeaders: Array<string | undefined> = []
    const url = await serve((req, res, body) => {
      sessionHeaders.push(req.headers['mcp-session-id'] as string | undefined)
      const parsed = JSON.parse(body) as { id: number; method: string }
      if (parsed.method === 'initialize') {
        jsonError(res, 400, parsed.id, -32022)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: {} }))
    })
    const { client, messages, errors } = open(url, 'auto', { deliverErrorBodies: true })

    // Act
    await client.sink.write(request(1, 'initialize'))
    await client.sink.write(request(2, 'server/discover'))
    await client.sink.write(request(3, 'tools/list'))

    // Assert
    expect(messages).toHaveLength(3)
    expect(errors).toEqual([])
    expect(sessionHeaders).toEqual([undefined, undefined, undefined])
  })
})

describe('without deliverErrorBodies', () => {
  test('a 400 with a JSON body is an error, as before', async () => {
    const url = await serve((_req, res, body) => jsonError(res, 400, (JSON.parse(body) as { id: number }).id, -32602))
    const { client, messages } = open(url, 'stateless')

    await expect(client.sink.write(request(1, 'tools/list'))).rejects.toBeInstanceOf(UpstreamHttpStatusError)
    expect(messages).toEqual([])
  })
})
