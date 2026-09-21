import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test } from 'vitest'
import { runConnectBridge } from '../../src/cli/connect-bridge-cmd.js'
import { AGENT_TOKEN_ENV_VAR } from '../../src/cli/connect-constants.js'
import { waitUntil } from '../proxy/harness.js'
import { createCliCapture } from './connect-harness.js'

/**
 * The token sweep (plan task 5, PRD guarantee): a marker token is run through
 * every path this command has — success, 401, a network failure, a refusal —
 * and must appear in NONE of what the command wrote, on either channel.
 *
 * The positive guard is what stops the test from passing vacuously: a fake
 * service records the `authorization` header it actually received, so the
 * sweep proves the token went to the one place it belongs and nowhere else.
 */

const MARKER = 'mcpj_bridge-sweep-7c1e'

const openServers: Server[] = []

interface FakeService {
  readonly url: string
  /** Every `authorization` header value the service was sent, in order. */
  readonly seenAuth: Array<string | undefined>
}

/** A fake `serve` front that answers every POST with `status`. */
async function startService(status: number, body = '{"jsonrpc":"2.0","id":1,"result":{}}'): Promise<FakeService> {
  const seenAuth: Array<string | undefined> = []
  const server = createHttpServer((req: IncomingMessage, res) => {
    seenAuth.push(req.headers.authorization)
    req.resume()
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(status >= 200 && status < 300 ? body : '{"error":"refused"}')
    })
  })
  openServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/agents/reader/servers/files`, seenAuth }
}

/** A loopback port with nothing listening on it. */
async function refusedPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

interface SweepResult {
  readonly code: number
  readonly err: string
  /** Everything written to the PROTOCOL channel, which is a separate stream. */
  readonly protocol: string
  readonly cliOut: string
}

interface SweepArgs {
  readonly argv: readonly string[]
  readonly lines?: readonly string[]
  /**
   * Polled — with what the protocol channel holds so far — until true, before
   * the client hangs up. A fixed sleep is not enough: under a loaded suite the
   * POST had not yet left when stdin closed, and the sweep passed for the
   * wrong reason, the token simply never having travelled.
   */
  readonly until?: (protocol: string) => boolean
  /**
   * Leave stdin open and let the bridge decide when it is over. A real MCP
   * client does not hang up the moment it has sent a request, and a test that
   * does races the service's answer: the hang-up wins and the run ends 0
   * before the refusal ever lands.
   */
  readonly endsItself?: boolean
}

/** Runs one bridge to completion against `url`, writing `lines` to its stdin. */
async function sweep(args: SweepArgs): Promise<SweepResult> {
  const { argv, lines = [] } = args
  const io = createCliCapture()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const chunks: Buffer[] = []
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
  const protocolSoFar = (): string => Buffer.concat(chunks).toString('utf8')

  const done = runConnectBridge(argv, io, {
    env: { [AGENT_TOKEN_ENV_VAR]: MARKER },
    stdin,
    stdout,
    clientOptions: { sseReconnectMaxAttempts: 0, delay: () => Promise.resolve() },
  })
  for (const line of lines) stdin.write(line)
  const until = args.until
  if (until !== undefined) await waitUntil(() => until(protocolSoFar()))
  if (args.endsItself !== true) stdin.end()

  const code = await done
  return {
    code,
    err: io.err(),
    protocol: Buffer.concat(chunks).toString('utf8'),
    cliOut: io.out(),
  }
}

const REQUEST = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'

describe('the agent token reaches the authorization header and nothing else', () => {
  test('a successful exchange: the service saw it, neither channel did', async () => {
    const service = await startService(200)

    const result = await sweep({
      argv: ['--url', service.url],
      lines: [REQUEST],
      until: () => service.seenAuth.length > 0,
    })

    // Positive guard: the token really did travel, so the assertions below
    // are about hygiene rather than about a bridge that never ran.
    expect(service.seenAuth).toContain(`Bearer ${MARKER}`)
    expect(result.err).not.toContain(MARKER)
    expect(result.protocol).not.toContain(MARKER)
    expect(result.cliOut).toBe('')
  })

  test('a 401 refusal names neither the token nor the path', async () => {
    const service = await startService(401)

    const result = await sweep({
      argv: ['--url', service.url],
      lines: [REQUEST],
      endsItself: true,
    })

    expect(service.seenAuth).toContain(`Bearer ${MARKER}`)
    expect(result.code).toBe(1)
    expect(result.err).toContain('did not accept the agent token')
    expect(result.err).not.toContain(MARKER)
    expect(result.protocol).not.toContain(MARKER)
  })

  test('a network failure reports the failure without the token', async () => {
    const port = await refusedPort()

    const result = await sweep({
      argv: ['--url', `http://127.0.0.1:${port}/agents/reader/servers/files`],
      lines: [REQUEST],
      // The bridge answers the request it could not deliver; wait for that
      // answer rather than for a duration.
      until: (protocol) => protocol.includes('\n'),
    })

    // The bridge survives a network failure and answers the request it could
    // not deliver, so the client sees a failed call rather than a hang.
    expect(result.code).toBe(0)
    expect(result.protocol).toContain('"error"')
    expect(result.err).not.toContain(MARKER)
    expect(result.protocol).not.toContain(MARKER)
  })

  test('a refusal decided before dialing never echoes it either', async () => {
    const result = await sweep({ argv: ['--url', `https://plane.example/?t=${MARKER}`] })

    expect(result.code).toBe(1)
    expect(result.err).not.toContain(MARKER)
    expect(result.protocol).toBe('')
  })

  test('an oversized fragment is reported by its size, not its content', async () => {
    const service = await startService(200)
    // Past MAX_LINE_BUFFER_BYTES and never terminated: the source drops it and
    // reports the DROP, which is a diagnostic built from a byte count.
    const huge = `{"jsonrpc":"2.0","id":1,"padding":"${MARKER.repeat(4_000_000)}`

    const result = await sweep({
      argv: ['--url', service.url],
      lines: [huge],
      until: () => true,
    })

    expect(result.err).toContain('oversized')
    expect(result.err).not.toContain(MARKER)
    expect(result.protocol).not.toContain(MARKER)
  })
})
