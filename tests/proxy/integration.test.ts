import { PassThrough } from 'node:stream'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { spawnServer } from '../../src/proxy/spawn.js'
import { splice } from '../../src/proxy/splice.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FAKE_SERVER_PATH = join(__dirname, '../fixtures/fake-server.mjs')

const POLL_INTERVAL_MS = 10
const POLL_TIMEOUT_MS = 5000

/** Polls until `predicate` is true or the timeout elapses. */
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitUntil: timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: Record<string, unknown>
}

describe('proxy integration: spawn + splice against a fake stdio MCP server', () => {
  test('relays initialize/tools-list/tools-call byte-identically, taps both directions, propagates exit code', async () => {
    const handle = spawnServer('node', [FAKE_SERVER_PATH])

    const clientToServerLines: string[] = []
    const serverToClientLines: string[] = []

    // Client-facing sink: what the proxy writes back "to the client".
    const clientInbox = new PassThrough()
    const clientInboxChunks: Buffer[] = []
    clientInbox.on('data', (chunk: Buffer) => clientInboxChunks.push(chunk))

    // server -> client direction, tapped
    splice(handle.stdout, clientInbox, (line) => serverToClientLines.push(line))

    // Client-simulated source: what "the client" writes, forwarded to the child's stdin.
    const clientOutbox = new PassThrough()
    splice(clientOutbox, handle.stdin, (line) => clientToServerLines.push(line))

    const requests: JsonRpcRequest[] = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'echo', arguments: { x: 1 } },
      },
    ]

    for (const request of requests) {
      clientOutbox.write(`${JSON.stringify(request)}\n`)
    }

    await waitUntil(() => serverToClientLines.length >= 3)

    // (a) responses byte-identical to what fake-server wrote: reconstruct
    // the raw bytes fake-server produced and compare against what arrived
    // at the client-facing destination via splice.
    const expectedBytes = Buffer.from(serverToClientLines.map((line) => `${line}\n`).join(''), 'utf8')
    expect(Buffer.concat(clientInboxChunks)).toEqual(expectedBytes)

    // (b) all lines seen by the tap callback in both directions
    expect(clientToServerLines).toHaveLength(3)
    const parsedRequests = clientToServerLines.map((line) => JSON.parse(line) as JsonRpcRequest)
    expect(parsedRequests.map((request) => request.method)).toEqual([
      'initialize',
      'tools/list',
      'tools/call',
    ])

    const parsedResponses = serverToClientLines.map((line) => JSON.parse(line) as { id: number })
    expect(parsedResponses.map((response) => response.id)).toEqual([1, 2, 3])

    // (c) child exit code propagated: closing stdin ends the fake server's
    // readline loop, which exits cleanly with code 0.
    clientOutbox.end()
    const exitCode = await handle.exitCode()
    expect(exitCode).toBe(0)
  })
})
