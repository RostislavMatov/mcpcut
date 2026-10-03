import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { AgentGrant } from '../../src/agents/schema.js'
import { AgentNotFoundError, createAgentsStore, InvalidServerNameError } from '../../src/agents/store.js'

/**
 * `setServerGrant` writes a WHOLE validated grant (or the result of an updater
 * run under the store's CAS) — the entry point of `mcpcut files grant|revoke`,
 * which must carry `paths`; `grantServer` keeps `paths` when it rewrites tools.
 */

let journalDir: string
const data = resolve('/data')

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-agents-set-grant-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

async function storeWithAgent(): Promise<ReturnType<typeof createAgentsStore>> {
  const store = createAgentsStore({ journalDir })
  await store.createAgent('bot')
  return store
}

describe('setServerGrant', () => {
  test('persists a whole grant including folder rules', async () => {
    const store = await storeWithAgent()
    const grant: AgentGrant = { tools: '*', paths: [{ path: data, ops: ['read'] }] }

    const record = await store.setServerGrant('bot', 'files', grant)

    expect(record.grants['files']).toEqual(grant)
    expect((await store.getAgent('bot'))?.grants['files']).toEqual(grant)
  })

  test('the updater form sees the current grant and its result is stored', async () => {
    const store = await storeWithAgent()
    await store.setServerGrant('bot', 'files', { tools: '*', paths: [{ path: data, ops: ['read'] }] })

    await store.setServerGrant('bot', 'files', (current) => ({ ...(current as AgentGrant), tools: ['read_file'] }))

    expect((await store.getAgent('bot'))?.grants['files']).toEqual({
      tools: ['read_file'],
      paths: [{ path: data, ops: ['read'] }],
    })
  })

  test('the updater receives undefined when the agent has no grant for the server', async () => {
    const store = await storeWithAgent()
    let seen: AgentGrant | undefined | 'unset' = 'unset'

    await store.setServerGrant('bot', 'files', (current) => {
      seen = current
      return { tools: '*' }
    })

    expect(seen).toBeUndefined()
  })

  test('schema validation still rejects a bad paths rule and writes nothing', async () => {
    const store = await storeWithAgent()
    const bad = { tools: '*', paths: [{ path: 'relative', ops: ['read'] }] } as AgentGrant

    await expect(store.setServerGrant('bot', 'files', bad)).rejects.toThrow()
    expect((await store.getAgent('bot'))?.grants).toEqual({})
  })

  test('rejects an unknown op and a repeated op', async () => {
    const store = await storeWithAgent()

    await expect(
      store.setServerGrant('bot', 'files', { tools: '*', paths: [{ path: data, ops: ['fly'] }] } as unknown as AgentGrant),
    ).rejects.toThrow()
    await expect(store.setServerGrant('bot', 'files', { tools: '*', paths: [{ path: data, ops: ['read', 'read'] }] })).rejects.toThrow()
  })

  test('rejects an unknown agent and an invalid server name', async () => {
    const store = await storeWithAgent()

    await expect(store.setServerGrant('ghost', 'files', { tools: '*' })).rejects.toBeInstanceOf(AgentNotFoundError)
    await expect(store.setServerGrant('bot', '__proto__', { tools: '*' })).rejects.toBeInstanceOf(InvalidServerNameError)
  })

  test('does not alias the caller object', async () => {
    const store = await storeWithAgent()
    const paths = [{ path: data, ops: ['read' as const] }]
    await store.setServerGrant('bot', 'files', { tools: '*', paths })

    paths.pop()

    expect((await store.getAgent('bot'))?.grants['files']?.paths).toHaveLength(1)
  })
})

describe('grantServer keeps folder rules', () => {
  test('re-granting tools of the files grant preserves its paths', async () => {
    const store = await storeWithAgent()
    const paths = [{ path: data, ops: ['read' as const] }]
    await store.setServerGrant('bot', 'files', { tools: '*', paths })

    await store.grantServer('bot', 'files', ['read_file'])

    expect((await store.getAgent('bot'))?.grants['files']).toEqual({ tools: ['read_file'], paths })
  })

  test('a grant that never had paths stays without the field', async () => {
    const store = await storeWithAgent()

    await store.grantServer('bot', 'github', '*')

    expect((await store.getAgent('bot'))?.grants['github']).toEqual({ tools: '*' })
  })
})
