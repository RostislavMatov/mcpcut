import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { readJournalRecords, waitUntil } from '../proxy/harness.js'
import {
  asOwner,
  createPlane,
  POOL_SERVER_FIXTURE,
  postMcp,
  rpcBody,
  runOnboarding,
  startServe,
  writePolicyFile,
  type Plane,
  type ServeRun,
} from './m3-harness.js'

/**
 * The PRD's headline metric for the pool, end to end: an agent connected to
 * ONE address sees a server it was granted after it connected — without a
 * config edit on its machine and without a restart.
 *
 * That is the whole point of the phase. The old shape put the source of truth
 * about an agent's access in a file on somebody else's laptop; this puts it in
 * the service, and the agent finds out by being told.
 */

const AGENT = 'pool-agent'
const POLL_MS = 25

let tempDir: string
let plane: Plane

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-pool-e2e-'))
  plane = createPlane(tempDir)
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/** Registers one fixture server exposing `tools`, as the documented flow does. */
async function addServer(name: string, tools: readonly string[]): Promise<void> {
  const owner = await asOwner(plane)
  const argv = [
    'server',
    'add',
    name,
    '--transport',
    'stdio',
    '--command',
    process.execPath,
    '--args',
    [POOL_SERVER_FIXTURE, ...tools].join(','),
    '--env',
    `POOL_FIXTURE_NAME=${name}`,
  ]
  const result = await plane.run(argv, owner)
  if (result.code !== 0) throw new Error(`server add ${name} failed: ${result.err}`)
}

/** Grants an existing agent one more server. */
async function grant(server: string): Promise<void> {
  const owner = await asOwner(plane)
  const argv = ['agent', 'grant', AGENT, server, '--tools', '*']
  const result = await plane.run(argv, owner)
  if (result.code !== 0) throw new Error(`agent grant ${server} failed: ${result.err}`)
}

interface PoolClient {
  readonly sessionId: string
  call(id: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
}

async function openPool(serve: ServeRun, token: string): Promise<PoolClient> {
  const url = serve.poolEndpoint()
  const opened = await postMcp({
    url,
    token,
    body: rpcBody(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }),
  })
  expect(opened.status).toBe(200)
  const sessionId = opened.headers.get('mcp-session-id') as string

  return {
    sessionId,
    call: async (id, method, params = {}) => {
      const response = await postMcp({
        url,
        token,
        body: rpcBody(id, method, params),
        headers: { 'mcp-session-id': sessionId },
      })
      const text = await response.text()
      return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>)
    },
  }
}

function toolNamesOf(body: Record<string, unknown>): string[] {
  const result = body['result'] as { tools?: { name: string }[] } | undefined
  return (result?.tools ?? []).map((entry) => entry.name)
}

/**
 * Reads the agent's server-initiated stream, collecting notification methods
 * as they arrive. The body never ends, so it is read incrementally and the
 * caller aborts it.
 */
function openNotificationStream(
  serve: ServeRun,
  token: string,
  sessionId: string,
): { methods: string[]; close(): void } {
  const controller = new AbortController()
  const methods: string[] = []

  void fetch(serve.poolEndpoint(), {
    headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sessionId },
    signal: controller.signal,
  })
    .then(async (response) => {
      if (response.body === null) return
      const decoder = new TextDecoder()
      let text = ''
      for await (const chunk of response.body) {
        text += decoder.decode(chunk as Uint8Array, { stream: true })
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue
          const parsed = JSON.parse(line.slice('data:'.length).trim()) as { method?: string }
          if (parsed.method !== undefined && !methods.includes(parsed.method)) {
            methods.push(parsed.method)
          }
        }
      }
    })
    .catch(() => undefined)

  return { methods, close: () => controller.abort() }
}

describe('e2e: one address, and the service decides what is behind it', () => {
  test('a server granted mid-session reaches the agent without a config edit', async () => {
    // Arrange — two servers, both granted, one live pool session.
    await writePolicyFile(plane, { defaultDecision: 'allow', quarantine: { enabled: false } })
    const token = await runOnboarding(plane, {
      serverName: 'alpha',
      agentName: AGENT,
      command: process.execPath,
      args: [POOL_SERVER_FIXTURE, 'echo'],
      env: { POOL_FIXTURE_NAME: 'alpha' },
      tools: '*',
    })
    await addServer('beta', ['query'])
    await grant('beta')
    const serve = await startServe(plane, [], { revocationPollIntervalMs: POLL_MS })

    try {
      const pool = await openPool(serve, token)
      const listed = await pool.call(2, 'tools/list')
      expect(toolNamesOf(listed)).toEqual(['alpha__echo', 'beta__query'])

      // A call goes through the pool to the right server, under its bare name.
      const called = await pool.call(3, 'tools/call', {
        name: 'alpha__echo',
        arguments: { text: 'hi' },
      })
      const content = (called['result'] as { content: { text: string }[] }).content
      expect(JSON.parse(content[0]?.text ?? '{}')).toMatchObject({ server: 'alpha' })

      // The stream must be open BEFORE the grant, or the notification lands in
      // the session's buffer instead of on the wire being watched.
      const stream = openNotificationStream(serve, token, pool.sessionId)
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Act — a third server is registered and granted while the agent holds
      // its session. Nothing on the agent's machine changes.
      await addServer('gamma', ['fetch'])
      await grant('gamma')

      // Assert — the agent is TOLD, and the next list contains the new server.
      await waitUntil(() => stream.methods.includes('notifications/tools/list_changed'))
      const relisted = await pool.call(4, 'tools/list')
      expect(toolNamesOf(relisted)).toEqual(['alpha__echo', 'beta__query', 'gamma__fetch'])
      stream.close()

      // And the pool wrote down what it did: the session, each attach, and the
      // membership change. Waited for rather than read once — the journal
      // writer batches, so the newest attach may still be in the batch.
      const pooledRecords = async () =>
        (await readJournalRecords(tempDir)).filter((record) => record.kind === 'pool')
      await waitUntil(async () => {
        const so_far = await pooledRecords()
        return (
          so_far.filter((record) => (record.payload as { event: string }).event === 'attach')
            .length >= 3
        )
      })
      const pooled = await pooledRecords()
      const events = pooled.map((record) => (record.payload as { event: string }).event)
      expect(events).toContain('open')
      expect(events).toContain('attach')
      expect(events).toContain('members-changed')
      // Every attach names the child session it opened — the binding a report
      // needs to tie a pooled call to the per-server decision underneath it.
      const attaches = pooled.filter(
        (record) => (record.payload as { event: string }).event === 'attach',
      )
      expect(attaches.length).toBeGreaterThanOrEqual(3)
      for (const attach of attaches) {
        expect((attach.payload as { childSessionId?: string }).childSessionId).toBeTruthy()
      }
    } finally {
      await serve.shutdown()
    }
  }, 30_000)

  test('a server whose grant is withdrawn leaves the pool while it stays open', async () => {
    await writePolicyFile(plane, { defaultDecision: 'allow', quarantine: { enabled: false } })
    const token = await runOnboarding(plane, {
      serverName: 'alpha',
      agentName: AGENT,
      command: process.execPath,
      args: [POOL_SERVER_FIXTURE, 'echo'],
      env: { POOL_FIXTURE_NAME: 'alpha' },
      tools: '*',
    })
    await addServer('beta', ['query'])
    await grant('beta')
    const serve = await startServe(plane, [], { revocationPollIntervalMs: POLL_MS })

    try {
      const pool = await openPool(serve, token)
      expect(toolNamesOf(await pool.call(2, 'tools/list'))).toHaveLength(2)

      const owner = await asOwner(plane)
      const ungranted = await plane.run(['agent', 'ungrant', AGENT, 'beta'], owner)
      expect(ungranted.code, ungranted.err).toBe(0)

      // The session lives on with fewer servers: losing one grant is a smaller
      // pool, not a closed one.
      await waitUntil(
        async () => toolNamesOf(await pool.call(3, 'tools/list')).length === 1,
        'the pool to shrink',
      )
      expect(toolNamesOf(await pool.call(4, 'tools/list'))).toEqual(['alpha__echo'])
    } finally {
      await serve.shutdown()
    }
  }, 30_000)
})
