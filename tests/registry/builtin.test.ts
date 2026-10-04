import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { parseRegistry, parseServerRecord } from '../../src/registry/schema.js'
import { createRegistryStore } from '../../src/registry/store.js'
import { BuiltinServerRefusedError } from '../../src/tenant/errors.js'
import type { TenantSettings } from '../../src/tenant/settings.js'

const LIMITS = { servers: 5, agents: 5, groups: 2, requestsPerSecond: 10, requestsPerDay: 10_000 } as const
const TENANT: TenantSettings = { isTenant: true, stdioServers: 'refused', upstreams: 'public-https', limits: LIMITS }

const FILES = { name: 'files', transport: 'builtin', kind: 'files' }

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcpcut-builtin-'))
  dirs.push(dir)
  return dir
}

describe('registry: builtin variant', () => {
  test('accepts the files server', () => {
    const result = parseServerRecord(FILES)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.record).toEqual(FILES)
  })

  test('refuses an unknown kind', () => {
    expect(parseServerRecord({ ...FILES, kind: 'shell' }).ok).toBe(false)
  })

  test('refuses a missing kind', () => {
    expect(parseServerRecord({ name: 'files', transport: 'builtin' }).ok).toBe(false)
  })

  test('is strict: a command, url or env on a builtin record is refused', () => {
    expect(parseServerRecord({ ...FILES, command: 'rm' }).ok).toBe(false)
    expect(parseServerRecord({ ...FILES, url: 'https://example.com' }).ok).toBe(false)
    expect(parseServerRecord({ ...FILES, env: {} }).ok).toBe(false)
  })

  test('lives in a registry document next to other servers', () => {
    const result = parseRegistry({ version: 1, servers: { files: FILES } })
    expect(result.ok).toBe(true)
  })
})

describe('registry store: builtin in tenant mode', () => {
  test('a normal install stores the builtin record', async () => {
    const store = createRegistryStore(await tempDir())
    await store.addServer(parseServerRecordOrThrow(FILES))
    expect((await store.getServer('files'))?.transport).toBe('builtin')
  })

  test('a tenant install refuses it with a one-line message', async () => {
    const store = createRegistryStore(await tempDir(), { tenant: TENANT })
    const attempt = store.addServer(parseServerRecordOrThrow(FILES))
    await expect(attempt).rejects.toBeInstanceOf(BuiltinServerRefusedError)
    await expect(attempt).rejects.toThrow(/built-in/)
    await expect(attempt).rejects.not.toThrow(/\n/)
  })
})

function parseServerRecordOrThrow(raw: unknown) {
  const parsed = parseServerRecord(raw)
  if (!parsed.ok) throw new Error('fixture invalid')
  return parsed.record
}

describe('registry store: a builtin record cannot be edited or imitated', () => {
  test('updateServer refuses to turn the builtin record into a stdio one', async () => {
    const store = createRegistryStore(await tempDir())
    await store.addServer(parseServerRecordOrThrow(FILES))
    const attempt = store.updateServer(parseServerRecordOrThrow({ name: 'files', transport: 'stdio', command: 'node' }))
    await expect(attempt).rejects.toThrow(/built-in/)
    expect((await store.getServer('files'))?.transport).toBe('builtin')
  })

  test('updateServer refuses to turn a stdio record into a builtin one', async () => {
    const store = createRegistryStore(await tempDir())
    await store.addServer(parseServerRecordOrThrow({ name: 'files', transport: 'stdio', command: 'node' }))
    await expect(store.updateServer(parseServerRecordOrThrow(FILES))).rejects.toThrow(/built-in/)
  })

  test('updating the builtin record to itself is a no-op success', async () => {
    const store = createRegistryStore(await tempDir())
    await store.addServer(parseServerRecordOrThrow(FILES))
    expect((await store.updateServer(parseServerRecordOrThrow(FILES))).status).toBe('updated')
  })
})
