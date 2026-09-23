import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createConnectStdio } from '../cli/connect-harness.js'
import { requestLine, waitUntil } from '../proxy/harness.js'
import {
  asOwner,
  createGrantedAgent,
  createPlane,
  POOL_SERVER_FIXTURE,
  startServe,
  writePolicyFile,
  type Plane,
} from './m3-harness.js'

/**
 * A resident through the product's own seams end to end (ADR-0016): a stdio
 * server granted to an agent is up before the agent's client starts, and two
 * runs of the `connect --url` bridge — a client closed and opened again — are
 * served by the SAME process.
 */

let tempDir: string
let plane: Plane

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-pool-residents-e2e-'))
  plane = createPlane(tempDir)
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

async function pidsIn(file: string): Promise<number[]> {
  const text = await readFile(file, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => Number(line.split(' ')[0]))
}

/** One client run: the bridge, a handshake, one list, then the client closes. */
async function oneClientRun(url: string, token: string): Promise<string[]> {
  const stdio = createConnectStdio()
  const bridge = plane.run(['connect', '--url', url], {
    connectBridge: {
      env: { MCP_AGENT_TOKEN: token },
      stdin: stdio.clientOutbox,
      stdout: stdio.clientStdout,
      clientOptions: { sseReconnectMaxAttempts: 1, delay: () => Promise.resolve() },
    },
  })
  const send = (line: string): void => void stdio.clientOutbox.write(line)
  const replyTo = async (id: number): Promise<Record<string, unknown>> => {
    await waitUntil(() => stdio.messages().some((message) => message['id'] === id))
    return stdio.messages().find((message) => message['id'] === id) ?? {}
  }
  send(requestLine(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } }))
  await replyTo(1)
  send(requestLine(2, 'tools/list'))
  const result = (await replyTo(2))['result'] as { tools?: { name: string }[] } | undefined
  stdio.clientOutbox.end()
  expect((await bridge).code).toBe(0)
  return (result?.tools ?? []).map((tool) => tool.name)
}

describe('e2e: a resident outlives the client', () => {
  test('two bridge runs of one agent are served by the same process', async () => {
    // Arrange
    await writePolicyFile(plane, { defaultDecision: 'allow', quarantine: { enabled: false } })
    const pidFile = join(tempDir, 'memory.pids')
    const owner = await asOwner(plane)
    const added = await plane.run(
      [
        'server', 'add', 'memory',
        '--transport', 'stdio',
        '--command', process.execPath,
        '--args', [POOL_SERVER_FIXTURE, 'echo'].join(','),
        '--env', 'POOL_FIXTURE_NAME=memory',
        '--env', `POOL_FIXTURE_PID_FILE=${pidFile}`,
      ],
      owner,
    )
    expect(added.code, added.err).toBe(0)
    const token = await createGrantedAgent(plane, 'bot', 'memory', '*')
    const serve = await startServe(plane, [], {
      revocationPollIntervalMs: 25,
      maxPoolResidents: 32,
      poolWarmIdleMs: 60_000,
      poolResidentReconcileMs: 40,
    })

    try {
      // The server is up before any client is. (`server add` probes it once
      // too, so the resident is the one start the supervisor reports.)
      await waitUntil(() => plane.allErr().includes('[serve] resident bot/memory: ready'))
      const before = await pidsIn(pidFile)
      const url = `http://127.0.0.1:${serve.port}`

      // Act
      const first = await oneClientRun(url, token)
      const second = await oneClientRun(url, token)

      // Assert
      expect(first).toEqual(['memory__echo'])
      expect(second).toEqual(['memory__echo'])
      expect(await pidsIn(pidFile)).toEqual(before)
      const resident = before.at(-1) as number
      expect(() => process.kill(resident, 0)).not.toThrow()
    } finally {
      await serve.shutdown()
    }
    for (const pid of await pidsIn(pidFile)) expect(() => process.kill(pid, 0)).toThrow()
  })
})
