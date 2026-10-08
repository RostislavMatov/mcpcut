import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createApprovalQueue, type PendingApproval } from '../../src/policy/approvals/queue.js'
import { POOL_ROUTE_PATH } from '../../src/transport/http/server-constants.js'
import {
  AGENT,
  disposeServeFixtures,
  POOL_SERVER,
  startServe,
  waitUntil,
  type ServeFixture,
} from './serve-harness.js'

/**
 * Decision M36, phase B, end to end through `serve`: a call held for a human
 * over HTTP is answered with an SSE stream — the "waiting" progress at once,
 * the answer when the admin decides — so an HTTP client's 60-second cut never
 * fires; and an agent whose POST closes takes its request with it (review R1):
 * withdrawn as `disconnected`, journaled `agent-gone`, never sent.
 */

afterEach(async () => {
  await disposeServeFixtures()
})

const SERVER = 'alpha'
const TOOL = 'echo'
const HELD_POLICY = { version: 1, defaultDecision: 'require-approval', quarantine: { enabled: false } }
const ACCEPT_BOTH = { accept: 'application/json, text/event-stream' }

async function startHeldServe(): Promise<ServeFixture> {
  const fixture = await startServe({ policy: HELD_POLICY, grant: '*', grantServer: SERVER })
  await fixture.registry.addServer({
    name: SERVER,
    transport: 'stdio',
    command: process.execPath,
    args: [POOL_SERVER, TOOL],
    env: { POOL_FIXTURE_NAME: SERVER },
  })
  return fixture
}

/** Opens a session at `path` and lists its tools (the inventory must have seen them). */
async function openSession(fixture: ServeFixture, path: string, toolName: string): Promise<string> {
  const opened = await fixture.post(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } }),
    {},
    path,
  )
  const session = opened.headers.get('mcp-session-id') as string
  const listed = await fixture.post(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), { 'mcp-session-id': session }, path)
  expect(await listed.text()).toContain(toolName)
  return session
}

function heldCall(id: number, name: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: { text: 'hi' }, _meta: { progressToken: `tok-${id}` } },
  })
}

/** Reads SSE events off a streaming response, as they arrive. */
function eventReader(response: Response): { next(): Promise<Record<string, any> | null> } {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  return {
    async next() {
      for (;;) {
        const boundary = buffered.indexOf('\n\n')
        if (boundary !== -1) {
          const block = buffered.slice(0, boundary)
          buffered = buffered.slice(boundary + 2)
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice('data: '.length))
            .join('\n')
          if (data !== '') return JSON.parse(data) as Record<string, any>
          continue // a `: ping` comment
        }
        const chunk = await reader.read()
        if (chunk.done) return null
        buffered += decoder.decode(chunk.value, { stream: true })
      }
    },
  }
}

async function onlyPending(fixture: ServeFixture): Promise<PendingApproval> {
  const queue = createApprovalQueue({ baseDir: join(fixture.journalDir, 'approvals') })
  let found: PendingApproval | undefined
  await waitUntil(async () => {
    found = (await queue.list())[0]
    return found !== undefined
  })
  return found!
}

describe('a call held for approval over HTTP streams until the admin decides', () => {
  test('pool: the progress comes at once on an SSE stream, the answer when approved', async () => {
    const fixture = await startHeldServe()
    const session = await openSession(fixture, POOL_ROUTE_PATH, `${SERVER}__${TOOL}`)

    const response = await fixture.post(heldCall(3, `${SERVER}__${TOOL}`), { 'mcp-session-id': session, ...ACCEPT_BOTH }, POOL_ROUTE_PATH)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const events = eventReader(response)
    const first = await events.next()
    expect(first).toMatchObject({
      method: 'notifications/progress',
      params: { progressToken: 'tok-3', progress: 1, message: 'waiting for a person to approve this call' },
    })
    const pending = await onlyPending(fixture)
    expect(pending.agentName).toBe(AGENT)

    await createApprovalQueue({ baseDir: join(fixture.journalDir, 'approvals') }).resolve(pending.approvalId, {
      outcome: 'approved',
      actor: 'cli:test',
    })

    // The server's own progress on the same token rides the same stream; the answer comes last.
    const after: Record<string, any>[] = []
    for (let event = await events.next(); event !== null; event = await events.next()) after.push(event)
    expect(after.at(-1)).toMatchObject({ id: 3, result: {} })
    expect(after.slice(0, -1).every((event) => event['method'] === 'notifications/progress')).toBe(true)
  })

  test('pool: closing the POST withdraws the held call as disconnected, and nothing is sent', async () => {
    const fixture = await startHeldServe()
    const session = await openSession(fixture, POOL_ROUTE_PATH, `${SERVER}__${TOOL}`)
    const controller = new AbortController()

    const response = await fetch(`${fixture.baseUrl}${POOL_ROUTE_PATH}`, {
      method: 'POST',
      body: heldCall(4, `${SERVER}__${TOOL}`),
      signal: controller.signal,
      headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json', 'mcp-session-id': session, ...ACCEPT_BOTH },
    })
    await eventReader(response).next() // held: the progress arrived
    const pending = await onlyPending(fixture)
    controller.abort()

    const queue = createApprovalQueue({ baseDir: join(fixture.journalDir, 'approvals') })
    await waitUntil(async () => (await queue.readResolution(pending.approvalId)) !== null)
    expect(await queue.readResolution(pending.approvalId)).toMatchObject({ outcome: 'withdrawn', reason: 'disconnected' })
    const late = await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'cli:test' })
    expect(late).toMatchObject({ ok: false, reason: 'withdrawn' })

    await waitUntil(async () =>
      (await fixture.journalRecords()).some((record) => record.kind === 'decision' && record.decision?.outcome === 'agent-gone'),
    )
    const decisions = (await fixture.journalRecords()).filter((record) => record.kind === 'decision' && record.decision?.toolName === TOOL)
    expect(decisions.map((record) => record.decision?.outcome)).toEqual(['require-approval-pending', 'agent-gone'])

    // The pool session itself lives on: another call is answered as usual.
    const after = await fixture.post(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }), { 'mcp-session-id': session }, POOL_ROUTE_PATH)
    expect(after.status).toBe(200)
  })

  test('per-server address: closing the POST ends the session and withdraws the held call', async () => {
    const fixture = await startHeldServe()
    const path = `/agents/${AGENT}/servers/${SERVER}`
    const session = await openSession(fixture, path, TOOL)
    const controller = new AbortController()

    const response = await fetch(`${fixture.baseUrl}${path}`, {
      method: 'POST',
      body: heldCall(6, TOOL),
      signal: controller.signal,
      headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json', 'mcp-session-id': session, ...ACCEPT_BOTH },
    })
    expect(await eventReader(response).next()).toMatchObject({ method: 'notifications/progress' })
    const pending = await onlyPending(fixture)
    controller.abort()

    const queue = createApprovalQueue({ baseDir: join(fixture.journalDir, 'approvals') })
    await waitUntil(async () => (await queue.readResolution(pending.approvalId)) !== null)
    expect(await queue.readResolution(pending.approvalId)).toMatchObject({ outcome: 'withdrawn', reason: 'disconnected' })
    const next = await fixture.post(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }), { 'mcp-session-id': session }, path)
    expect(next.status).toBe(404)
  })
})
