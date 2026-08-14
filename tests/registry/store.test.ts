import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ServerRecord } from '../../src/registry/schema.js'
import {
  createRegistryStore,
  DuplicateServerError,
  InvalidServerRecordError,
} from '../../src/registry/store.js'

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-registry-store-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

const GITHUB: ServerRecord = {
  name: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'vault:github-pat' },
}

const REMOTE: ServerRecord = {
  name: 'remote-api',
  transport: 'http',
  url: 'https://example.com/mcp',
  protocol: 'auto',
}

describe('createRegistryStore', () => {
  test('starts empty: listServers returns [] and getServer returns undefined', async () => {
    const store = createRegistryStore(journalDir)

    expect(await store.listServers()).toEqual([])
    expect(await store.getServer('github')).toBeUndefined()
  })

  test('addServer persists the record and getServer returns it', async () => {
    const store = createRegistryStore(journalDir)

    await store.addServer(GITHUB)

    expect(await store.getServer('github')).toEqual(GITHUB)
  })

  test('state db is created with owner-only permissions (0600)', async () => {
    const store = createRegistryStore(journalDir)

    await store.addServer(GITHUB)

    const stats = await stat(join(journalDir, 'state.db'))
    expect(stats.mode & 0o777).toBe(0o600)
  })

  test('addServer rejects a duplicate name with DuplicateServerError', async () => {
    const store = createRegistryStore(journalDir)
    await store.addServer(GITHUB)

    await expect(store.addServer({ ...GITHUB, command: 'other' })).rejects.toBeInstanceOf(
      DuplicateServerError,
    )
  })

  test('addServer rejects an invalid record with InvalidServerRecordError', async () => {
    const store = createRegistryStore(journalDir)
    const invalid = { name: 'BAD NAME', transport: 'stdio', command: 'x' } as unknown as ServerRecord

    await expect(store.addServer(invalid)).rejects.toBeInstanceOf(InvalidServerRecordError)
  })

  test('listServers returns all records sorted by name', async () => {
    const store = createRegistryStore(journalDir)
    await store.addServer(REMOTE)
    await store.addServer(GITHUB)

    const names = (await store.listServers()).map((record) => record.name)

    expect(names).toEqual(['github', 'remote-api'])
  })

  test('removeServer returns the removed record and the server is gone', async () => {
    const store = createRegistryStore(journalDir)
    await store.addServer(GITHUB)

    const result = await store.removeServer('github')

    expect(result).toEqual({ status: 'removed', record: GITHUB })
    expect(await store.getServer('github')).toBeUndefined()
  })

  test('removeServer on a missing name returns a typed not-found result', async () => {
    const store = createRegistryStore(journalDir)

    expect(await store.removeServer('nope')).toEqual({ status: 'not-found' })
  })

  test('state persists across store instances (same directory)', async () => {
    await createRegistryStore(journalDir).addServer(GITHUB)

    const reopened = createRegistryStore(journalDir)

    expect(await reopened.getServer('github')).toEqual(GITHUB)
  })

  test('mutating a returned record does not affect the stored state', async () => {
    const store = createRegistryStore(journalDir)
    await store.addServer(GITHUB)

    const record = await store.getServer('github')
    if (record !== undefined && record.transport === 'stdio' && record.args !== undefined) {
      // Deliberate mutation of the *returned copy* to prove store isolation.
      ;(record.args as string[]).push('--evil')
    }

    const reread = await store.getServer('github')
    expect(reread).toEqual(GITHUB)
  })
})
