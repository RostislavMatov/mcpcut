import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createEffectiveAgentReader } from '../../src/agents/effective-reader.js'
import { createAgentsStore } from '../../src/agents/store.js'
import type { GroupRecord } from '../../src/groups/schema.js'
import { createGroupsStore } from '../../src/groups/store.js'
import { createFilesEndpoints, createAgentFilesBackend, type FilesBackend } from '../../src/files/upstream.js'
import { clientMessage, type McpMessage } from '../../src/transport/message.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const BACKEND: FilesBackend = { roots: async () => [], rules: async () => [], actor: 'tester' }

function open(backend: FilesBackend = BACKEND) {
  const errors: unknown[] = []
  const endpoints = createFilesEndpoints(backend, (error) => errors.push(error))
  const received: unknown[] = []
  const rawMessages: McpMessage[] = []
  endpoints.source.onMessage((message) => {
    rawMessages.push(message)
    received.push(JSON.parse(message.bytes.toString('utf8')))
  })
  cleanups.push(() => endpoints.close())
  const send = (request: unknown): Promise<void> =>
    endpoints.sink.write(clientMessage(Buffer.from(typeof request === 'string' ? request : JSON.stringify(request))))
  return { endpoints, received, rawMessages, errors, send }
}

describe('createFilesEndpoints', () => {
  test('answers initialize with a JSON-RPC response on the source', async () => {
    const { send, received } = open()
    await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'mcpcut-files' } } })
  })

  test('tools/list lists the nine tools', async () => {
    const { send, received } = open()
    await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const result = (received[0] as { result: { tools: { name: string }[] } }).result
    expect(result.tools).toHaveLength(9)
  })

  test('server messages carry origin server and no terminator key', async () => {
    const { send, rawMessages } = open()
    await send({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(rawMessages[0]?.meta).toEqual({ origin: 'server' })
  })

  test('a notification gets no answer', async () => {
    const { send, received } = open()
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(received).toEqual([])
  })

  test('invalid JSON gets a parse error answer, not a crash', async () => {
    const { send, received } = open()
    await send('{nope')
    expect(received[0]).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } })
  })

  test('answers come in the order the requests were sent', async () => {
    const { send, received } = open()
    await Promise.all([
      send({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'list_roots' } }),
      send({ jsonrpc: '2.0', id: 'b', method: 'ping' }),
    ])
    expect(received.map((entry) => (entry as { id: string }).id)).toEqual(['a', 'b'])
  })

  test('nothing is delivered after close, and close is idempotent', async () => {
    const { endpoints, send, received } = open()
    await endpoints.close()
    await endpoints.close()
    await send({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(received).toEqual([])
  })

  test('a failing backend yields a tool error answer and reports through onError', async () => {
    const broken: FilesBackend = { ...BACKEND, roots: async () => { throw new Error('disk gone') } }
    const { send, received } = open(broken)
    await send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_roots' } })
    expect(received[0]).toMatchObject({ id: 1, result: { isError: true } })
  })
})

describe('createAgentFilesBackend', () => {
  async function fixture() {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'mcpcut-files-up-')))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const agents = createAgentsStore({ journalDir: dir })
    const groups = createGroupsStore({ journalDir: dir })
    const reader = createEffectiveAgentReader({ agents, groups })
    await agents.createAgent('me')
    return { dir, agents, groups, reader }
  }

  test('actor is the agent name and rules are the files grant paths', async () => {
    const { agents, reader, dir } = await fixture()
    await agents.setServerGrant('me', 'files', { tools: '*', paths: [{ path: dir, ops: ['read'] }] })
    const backend = createAgentFilesBackend({ agentName: 'me', agents: reader, journalDir: dir })
    expect(backend.actor).toBe('me')
    expect(await backend.rules()).toEqual([{ path: dir, ops: ['read'] }])
  })

  test('rules are re-read on every call, so a revoked rule disappears at once', async () => {
    const { agents, reader, dir } = await fixture()
    await agents.setServerGrant('me', 'files', { tools: '*', paths: [{ path: dir, ops: ['read'] }] })
    const backend = createAgentFilesBackend({ agentName: 'me', agents: reader, journalDir: dir })
    expect(await backend.rules()).toHaveLength(1)
    await agents.setServerGrant('me', 'files', { tools: '*' })
    expect(await backend.rules()).toEqual([])
  })

  test('a revoked agent has no rules', async () => {
    const { agents, reader, dir } = await fixture()
    await agents.setServerGrant('me', 'files', { tools: '*', paths: [{ path: dir, ops: ['read'] }] })
    const backend = createAgentFilesBackend({ agentName: 'me', agents: reader, journalDir: dir })
    await agents.revokeAgent('me')
    expect(await backend.rules()).toEqual([])
  })

  test('an unknown agent has no rules', async () => {
    const { reader, dir } = await fixture()
    const backend = createAgentFilesBackend({ agentName: 'ghost', agents: reader, journalDir: dir })
    expect(await backend.rules()).toEqual([])
  })

  test('group rules apply (agent has no personal files grant)', async () => {
    const { agents, dir } = await fixture()
    const team: GroupRecord = {
      name: 'team',
      createdAt: '2026-10-04T00:00:00.000Z',
      grants: { files: { tools: '*', paths: [{ path: dir, ops: ['read', 'write'] }] } },
      members: ['me'],
    }
    const reader = createEffectiveAgentReader({ agents, groups: { groupsOf: async () => [team] } })
    const backend = createAgentFilesBackend({ agentName: 'me', agents: reader, journalDir: dir })
    expect(await backend.rules()).toEqual([{ path: dir, ops: ['read', 'write'] }])
  })

  test('roots are read fresh from the roots store', async () => {
    const { dir, reader } = await fixture()
    const { createRootsStore } = await import('../../src/files/roots-store.js')
    const store = createRootsStore({ journalDir: dir })
    const backend = createAgentFilesBackend({ agentName: 'me', agents: reader, journalDir: dir })
    expect(await backend.roots()).toEqual([])
    const other = path.join(dir, '..', `${path.basename(dir)}-files`)
    await mkdir(other)
    cleanups.push(() => rm(other, { recursive: true, force: true }))
    await store.add(other)
    expect(await backend.roots()).toEqual([other])
  })

  test('a root that holds or lies in mcpcut data is dropped, so an agent never reaches the modules folder', async () => {
    const { dir, reader } = await fixture()
    const { createRootsStore } = await import('../../src/files/roots-store.js')
    const store = createRootsStore({ journalDir: dir })
    await mkdir(path.join(dir, 'inside'))
    await store.add(dir)
    await store.add(path.join(dir, 'inside'))
    await store.add(path.dirname(dir))
    const backend = createAgentFilesBackend({ agentName: 'me', agents: reader, journalDir: dir })
    expect(await backend.roots()).toEqual([])
  })
})
