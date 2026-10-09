import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test } from 'vitest'
import { runConnectBridge } from '../../src/cli/connect-bridge-cmd.js'
import { AGENT_TOKEN_ENV_VAR } from '../../src/cli/connect-constants.js'
import { POOL_ROUTE_PATH } from '../../src/transport/http/server-constants.js'
import { createCliCapture } from './connect-harness.js'
import { disposeServeFixtures, POOL_SERVER, startServe, waitUntil, type ServeFixture } from './serve-harness.js'

/**
 * Decision M39, end to end: a `tools/call` with Claude Code's tool-use id,
 * already running at the server, loses the bridge's connection to `serve`.
 * The bridge sends it again under an id of its own; `serve` recognises the
 * same tool use and joins the call still running; the server runs it ONCE,
 * and the agent gets that one answer under the id it asked with.
 */

const SERVER = 'alpha'
const TOOL = 'slow_echo'
const SLOW_MS = 1_500

interface CutProxy {
  readonly port: number
  /** Drops every connection open now, both ends, the way a network blip does. */
  cutAll(): void
  close(): Promise<void>
}

/**
 * A TCP relay between the bridge and `serve` that the test can cut. `serve`
 * screens the Host header against its own port, so the relay rewrites it (in
 * latin1, which round-trips every byte).
 */
async function startCutProxy(targetPort: number): Promise<CutProxy> {
  const open = new Set<Socket>()
  let ownHost = ''
  const server: Server = createServer((inbound) => {
    const outbound = createConnection({ host: '127.0.0.1', port: targetPort })
    for (const socket of [inbound, outbound]) {
      open.add(socket)
      socket.on('close', () => open.delete(socket))
      socket.on('error', () => undefined)
    }
    inbound.on('data', (chunk: Buffer) => {
      outbound.write(Buffer.from(chunk.toString('latin1').replaceAll(ownHost, `127.0.0.1:${targetPort}`), 'latin1'))
    })
    outbound.pipe(inbound)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no proxy port')
  ownHost = `127.0.0.1:${address.port}`
  return {
    port: address.port,
    cutAll: () => {
      for (const socket of [...open]) socket.destroy()
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of [...open]) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

let proxy: CutProxy | undefined

afterEach(async () => {
  await proxy?.close()
  proxy = undefined
  await disposeServeFixtures()
})

function startBridge(fixture: ServeFixture, port: number) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const lines: Record<string, any>[] = []
  let buffered = ''
  stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    for (let index = buffered.indexOf('\n'); index !== -1; index = buffered.indexOf('\n')) {
      const line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      if (line.trim() !== '') lines.push(JSON.parse(line) as Record<string, any>)
    }
  })
  const capture = createCliCapture()
  const code = runConnectBridge(['--url', `http://127.0.0.1:${port}${POOL_ROUTE_PATH}`], capture, {
    env: { [AGENT_TOKEN_ENV_VAR]: fixture.token },
    stdin,
    stdout,
    retryDelaysMs: [200, 400, 800],
  })
  return {
    send: (message: unknown) => stdin.write(`${JSON.stringify(message)}\n`),
    lines,
    stderr: () => capture.err(),
    async next(accept: (message: Record<string, any>) => boolean): Promise<Record<string, any>> {
      let found: Record<string, any> | undefined
      await waitUntil(() => {
        const index = lines.findIndex(accept)
        if (index === -1) return false
        found = lines.splice(index, 1)[0]
        return true
      }, 'a matching line from the bridge')
      return found!
    },
    hangUp: () => stdin.end(),
    code,
  }
}

describe('connect --url: a dropped call with a tool-use id is sent again and runs once (M39)', () => {
  test('the agent gets the one answer under its own id; the journal shows one run and the resend', async () => {
    // Arrange: an allowed slow tool behind a proxy the test can cut.
    const fixture = await startServe({ policy: { version: 1, defaultDecision: 'allow', quarantine: { enabled: false } }, grant: '*', grantServer: SERVER })
    await fixture.registry.addServer({
      name: SERVER,
      transport: 'stdio',
      command: process.execPath,
      args: [POOL_SERVER, TOOL],
      env: { POOL_FIXTURE_NAME: SERVER, POOL_FIXTURE_DELAY_MS: String(SLOW_MS) },
    })
    proxy = await startCutProxy(Number(new URL(fixture.baseUrl).port))
    const bridge = startBridge(fixture, proxy.port)
    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } })
    await bridge.next((message) => message['id'] === 1)
    bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await bridge.next((message) => message['id'] === 2)

    // Act: the call starts running, then the network drops under it.
    bridge.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: `${SERVER}__${TOOL}`, arguments: { text: 'once' }, _meta: { 'claudecode/toolUseId': 'toolu_e2e', progressToken: 3 } },
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    proxy.cutAll()

    // Assert: one answer, under id 3, with the server's own result.
    const answer = await bridge.next((message) => message['id'] !== undefined && message['method'] === undefined)
    expect(answer['id']).toBe(3)
    expect(answer['result']).toBeDefined()
    expect(bridge.stderr()).toContain('sending it again')

    const outcomesNow = async (): Promise<(string | undefined)[]> =>
      (await fixture.journalRecords())
        .filter((record) => record.kind === 'decision' && record.decision?.toolName === TOOL)
        .map((record) => record.decision?.outcome)
    await waitUntil(async () => (await outcomesNow()).includes('replayed'), 'the replayed record')
    const outcomes = await outcomesNow()
    // One `allow` = forwarded once; the resend was `replayed`, never forwarded.
    expect(outcomes.filter((outcome) => outcome === 'allow')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === 'replayed')).toHaveLength(1)
    expect(outcomes).toContain('undelivered')
    bridge.hangUp()
    expect(await bridge.code).toBe(0)
  })
})
