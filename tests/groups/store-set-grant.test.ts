import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { AgentGrant } from '../../src/agents/schema.js'
import { InvalidServerNameError } from '../../src/agents/store.js'
import { createGroupsStore, GroupNotFoundError, type GroupsStore } from '../../src/groups/store.js'

/**
 * `setServerGrant` writes a WHOLE validated grant (or the result of an updater
 * run under the store's CAS) — the entry point of `mcpcut files grant|revoke
 * --group`; `grantServer` keeps `paths` when it rewrites tools (ADR-0020 §2).
 */

let journalDir: string
let store: GroupsStore
const data = resolve('/data')

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-groups-set-grant-'))
  store = createGroupsStore({ journalDir })
  await store.createGroup('team')
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

describe('setServerGrant', () => {
  test('persists a whole grant including folder rules', async () => {
    const grant: AgentGrant = { tools: '*', paths: [{ path: data, ops: ['read'] }] }

    const record = await store.setServerGrant('team', 'files', grant)

    expect(record.grants['files']).toEqual(grant)
    expect((await store.getGroup('team'))?.grants['files']).toEqual(grant)
  })

  test('the updater form sees the current grant and its result is stored', async () => {
    await store.setServerGrant('team', 'files', { tools: '*', paths: [{ path: data, ops: ['read'] }] })

    await store.setServerGrant('team', 'files', (current) => ({ ...(current as AgentGrant), tools: ['read_file'] }))

    expect((await store.getGroup('team'))?.grants['files']).toEqual({
      tools: ['read_file'],
      paths: [{ path: data, ops: ['read'] }],
    })
  })

  test('the updater receives undefined when the group has no grant for the server', async () => {
    let seen: AgentGrant | undefined | 'unset' = 'unset'

    await store.setServerGrant('team', 'files', (current) => {
      seen = current
      return { tools: '*' }
    })

    expect(seen).toBeUndefined()
  })

  test('schema validation rejects a bad paths rule and writes nothing', async () => {
    const bad = { tools: '*', paths: [{ path: 'relative', ops: ['read'] }] } as AgentGrant

    await expect(store.setServerGrant('team', 'files', bad)).rejects.toThrow()
    expect((await store.getGroup('team'))?.grants).toEqual({})
  })

  test('rejects an unknown group and an invalid server name', async () => {
    await expect(store.setServerGrant('ghost', 'files', { tools: '*' })).rejects.toBeInstanceOf(GroupNotFoundError)
    await expect(store.setServerGrant('team', '__proto__', { tools: '*' })).rejects.toBeInstanceOf(InvalidServerNameError)
  })

  test('does not alias the caller object', async () => {
    const paths = [{ path: data, ops: ['read' as const] }]
    await store.setServerGrant('team', 'files', { tools: '*', paths })

    paths.pop()

    expect((await store.getGroup('team'))?.grants['files']?.paths).toHaveLength(1)
  })
})

describe('grantServer keeps folder rules', () => {
  test('re-granting tools of the files grant preserves its paths', async () => {
    const paths = [{ path: data, ops: ['read' as const] }]
    await store.setServerGrant('team', 'files', { tools: '*', paths })

    await store.grantServer('team', 'files', ['read_file'])

    expect((await store.getGroup('team'))?.grants['files']).toEqual({ tools: ['read_file'], paths })
  })

  test('a server without paths gets none', async () => {
    await store.grantServer('team', 'notes', ['read_note'])
    await store.grantServer('team', 'notes', ['list_*'])

    expect((await store.getGroup('team'))?.grants['notes']).toEqual({ tools: ['list_*'] })
  })
})
