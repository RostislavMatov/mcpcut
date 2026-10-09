import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test } from 'vitest'
import { runConnectBridge } from '../../src/cli/connect-bridge-cmd.js'
import { AGENT_TOKEN_ENV_VAR } from '../../src/cli/connect-constants.js'
import { createApprovalQueue, type PendingApproval } from '../../src/policy/approvals/queue.js'
import { POOL_ROUTE_PATH } from '../../src/transport/http/server-constants.js'
import { createCliCapture } from './connect-harness.js'
import { disposeServeFixtures, POOL_SERVER, startServe, waitUntil, type ServeFixture } from './serve-harness.js'

/**
 * Decision M36, phase B, on the default path `agent config` writes: the
 * agent's client speaks stdio to `mcpcut connect --url`, which speaks HTTP to
 * `serve`, where the gate holds the call. The bridge is ours on both sides, so
 * this is where "the progress reaches the client" and "a client that leaves
 * takes its request with it" are proven together.
 */

afterEach(async () => {
  await disposeServeFixtures()
})

const SERVER = 'alpha'
const TOOL = 'echo'
const HELD_POLICY = { version: 1, defaultDecision: 'require-approval', quarantine: { enabled: false } }

interface Bridge {
  send(message: unknown): void
  /** The next line on the bridge's stdout matching `accept`, parsed. */
  next(accept: (message: Record<string, any>) => boolean): Promise<Record<string, any>>
  /** The client hangs up (stdin ends), as Claude Code exiting does. */
  hangUp(): void
  readonly code: Promise<number>
}

function startBridge(fixture: ServeFixture): Bridge {
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
  const code = runConnectBridge(['--url', `${fixture.baseUrl}${POOL_ROUTE_PATH}`], createCliCapture(), {
    env: { [AGENT_TOKEN_ENV_VAR]: fixture.token },
    stdin,
    stdout,
  })
  return {
    send: (message) => stdin.write(`${JSON.stringify(message)}\n`),
    async next(accept) {
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

async function startHeldBridge(): Promise<{ fixture: ServeFixture; bridge: Bridge }> {
  const fixture = await startServe({ policy: HELD_POLICY, grant: '*', grantServer: SERVER })
  await fixture.registry.addServer({
    name: SERVER,
    transport: 'stdio',
    command: process.execPath,
    args: [POOL_SERVER, TOOL],
    env: { POOL_FIXTURE_NAME: SERVER },
  })
  const bridge = startBridge(fixture)
  bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } })
  await bridge.next((message) => message['id'] === 1)
  bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  await bridge.next((message) => message['id'] === 2)
  bridge.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: `${SERVER}__${TOOL}`, arguments: { text: 'hi' }, _meta: { progressToken: 7 } },
  })
  return { fixture, bridge }
}

async function onlyPending(fixture: ServeFixture): Promise<PendingApproval> {
  const queue = createApprovalQueue({ baseDir: join(fixture.journalDir, 'approvals') })
  let found: PendingApproval | undefined
  await waitUntil(async () => {
    found = (await queue.list())[0]
    return found !== undefined
  }, 'a pending approval')
  return found!
}

describe('connect --url: a held call through the bridge', () => {
  test('the client hears at once that the call waits, then gets the answer when it is approved', async () => {
    const { fixture, bridge } = await startHeldBridge()

    const progress = await bridge.next((message) => message['method'] === 'notifications/progress')
    expect(progress['params']).toEqual({ progressToken: 7, progress: 1, message: 'waiting for a person to approve this call' })
    const pending = await onlyPending(fixture)
    await createApprovalQueue({ baseDir: join(fixture.journalDir, 'approvals') }).resolve(pending.approvalId, {
      outcome: 'approved',
      actor: 'cli:test',
    })

    const answer = await bridge.next((message) => message['id'] === 3)
    expect(answer['result']).toBeDefined()
    bridge.hangUp()
    expect(await bridge.code).toBe(0)
  })

  test('a client that hangs up while the call is held takes its request with it', async () => {
    const { fixture, bridge } = await startHeldBridge()
    await bridge.next((message) => message['method'] === 'notifications/progress')
    const pending = await onlyPending(fixture)

    bridge.hangUp()
    expect(await bridge.code).toBe(0)

    const queue = createApprovalQueue({ baseDir: join(fixture.journalDir, 'approvals') })
    await waitUntil(async () => (await queue.readResolution(pending.approvalId)) !== null, 'the withdrawal')
    expect(await queue.readResolution(pending.approvalId)).toMatchObject({ outcome: 'withdrawn', reason: 'disconnected' })
  })

  test('Esc in the client (a cancel) withdraws the held call with the client\'s reason', async () => {
    const { fixture, bridge } = await startHeldBridge()
    await bridge.next((message) => message['method'] === 'notifications/progress')
    const pending = await onlyPending(fixture)

    bridge.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3, reason: 'AbortError: user-cancel' } })

    const queue = createApprovalQueue({ baseDir: join(fixture.journalDir, 'approvals') })
    await waitUntil(async () => (await queue.readResolution(pending.approvalId)) !== null, 'the withdrawal')
    expect(await queue.readResolution(pending.approvalId)).toMatchObject({
      outcome: 'withdrawn',
      reason: 'AbortError: user-cancel',
    })
    bridge.hangUp()
    await bridge.code
  })
})
