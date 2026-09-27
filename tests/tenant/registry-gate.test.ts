import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAgentsStore, TooManyAgentsError } from '../../src/agents/store.js'
import { createGroupsStore, TooManyGroupsError } from '../../src/groups/store.js'
import type { ServerRecord } from '../../src/registry/schema.js'
import {
  createRegistryStore,
  InvalidServerRecordError,
  TooManyServersError,
} from '../../src/registry/store.js'
import { StdioServerRefusedError } from '../../src/tenant/errors.js'
import type { TenantSettings } from '../../src/tenant/settings.js'

/**
 * Registry/agents/groups write gates in tenant mode (PRD `hosted-accounts`,
 * phase 1, task 7, ADR-0017). Each store keeps taking a plain `tenant`
 * override so a test can drive it directly, without going through the
 * install config; every writer in the product picks up the SAME behavior for
 * free because `createRegistryStore`/`createAgentsStore`/`createGroupsStore`
 * default that option to `TENANT_SETTINGS` (`src/tenant/settings.ts`).
 *
 * GOTCHA under test: the per-store ceiling is enforced ONLY on write. A
 * document that already holds more entries than a newly-turned-on ceiling
 * must still be READABLE — see "an oversized document stays readable".
 */

const STDIO_REFUSED: TenantSettings = {
  isTenant: true,
  stdioServers: 'refused',
  upstreams: 'any',
  limits: { servers: 200, agents: 200, groups: 100, requestsPerSecond: 10, requestsPerDay: 10_000 },
}

const PUBLIC_HTTPS_ONLY: TenantSettings = {
  isTenant: true,
  stdioServers: 'allowed',
  upstreams: 'public-https',
  limits: { servers: 200, agents: 200, groups: 100, requestsPerSecond: 10, requestsPerDay: 10_000 },
}

function withLimits(limits: TenantSettings['limits']): TenantSettings {
  return { isTenant: true, stdioServers: 'allowed', upstreams: 'any', limits }
}

const STDIO: ServerRecord = {
  name: 'legacy-fs',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem'],
}

const HTTPS: ServerRecord = {
  name: 'remote-api',
  transport: 'http',
  url: 'https://example.com/mcp',
  protocol: 'auto',
}

const PLAIN_HTTP: ServerRecord = {
  name: 'internal',
  transport: 'http',
  url: 'http://169.254.169.254/mcp',
  protocol: 'auto',
}

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-tenant-registry-gate-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

describe('registry: stdioServers refused', () => {
  test('addServer of a stdio record is refused before it ever reaches the store', async () => {
    const store = createRegistryStore(journalDir, { tenant: STDIO_REFUSED })

    await expect(store.addServer(STDIO)).rejects.toBeInstanceOf(StdioServerRefusedError)
    await expect(store.addServer(STDIO)).rejects.toThrow(
      'server "legacy-fs" is stdio: this install refuses stdio servers (tenant mode) — register it over https',
    )
    expect(await store.listServers()).toEqual([])
  })

  test('updateServer turning an existing https record into stdio is refused, original record untouched', async () => {
    const store = createRegistryStore(journalDir, { tenant: STDIO_REFUSED })
    await store.addServer(HTTPS)

    await expect(
      store.updateServer({ ...STDIO, name: HTTPS.name }),
    ).rejects.toBeInstanceOf(StdioServerRefusedError)
    expect(await store.getServer(HTTPS.name)).toEqual(HTTPS)
  })

  test('an http record is unaffected', async () => {
    const store = createRegistryStore(journalDir, { tenant: STDIO_REFUSED })

    await expect(store.addServer(HTTPS)).resolves.toEqual(HTTPS)
  })
})

describe('registry: upstreams public-https only', () => {
  test('addServer of a plain http:// url is refused with the fixed message', async () => {
    const store = createRegistryStore(journalDir, { tenant: PUBLIC_HTTPS_ONLY })

    await expect(store.addServer(PLAIN_HTTP)).rejects.toBeInstanceOf(InvalidServerRecordError)
    await expect(store.addServer(PLAIN_HTTP)).rejects.toThrow(
      'url: this install reaches only https servers (tenant mode)',
    )
    expect(await store.listServers()).toEqual([])
  })

  test('addServer of an https:// url succeeds', async () => {
    const store = createRegistryStore(journalDir, { tenant: PUBLIC_HTTPS_ONLY })

    await expect(store.addServer(HTTPS)).resolves.toEqual(HTTPS)
  })

  test('updateServer turning an existing https record into plain http is refused, original untouched', async () => {
    const store = createRegistryStore(journalDir, { tenant: PUBLIC_HTTPS_ONLY })
    await store.addServer(HTTPS)

    await expect(
      store.updateServer({ ...PLAIN_HTTP, name: HTTPS.name }),
    ).rejects.toBeInstanceOf(InvalidServerRecordError)
    expect(await store.getServer(HTTPS.name)).toEqual(HTTPS)
  })
})

describe('registry: upstreams public-https reaches only port 443 (O8)', () => {
  const NON_DEFAULT_PORT: ServerRecord = {
    name: 'remote-api',
    transport: 'http',
    url: 'https://example.com:8443/mcp',
    protocol: 'auto',
  }

  test('addServer of a url naming an explicit non-443 port is refused with the fixed message', async () => {
    const store = createRegistryStore(journalDir, { tenant: PUBLIC_HTTPS_ONLY })

    await expect(store.addServer(NON_DEFAULT_PORT)).rejects.toBeInstanceOf(InvalidServerRecordError)
    await expect(store.addServer(NON_DEFAULT_PORT)).rejects.toThrow(
      'url: this install reaches only port 443 (tenant mode)',
    )
    expect(await store.listServers()).toEqual([])
  })

  test('a url with no port at all succeeds', async () => {
    const store = createRegistryStore(journalDir, { tenant: PUBLIC_HTTPS_ONLY })

    await expect(store.addServer(HTTPS)).resolves.toEqual(HTTPS)
  })

  test('a url with an explicit :443 succeeds (the URL parser normalizes it to the default)', async () => {
    const store = createRegistryStore(journalDir, { tenant: PUBLIC_HTTPS_ONLY })
    const explicit443: ServerRecord = { ...HTTPS, url: 'https://example.com:443/mcp' }

    await expect(store.addServer(explicit443)).resolves.toEqual(explicit443)
  })

  test('updateServer moving an existing record to a non-443 port is refused, original untouched', async () => {
    const store = createRegistryStore(journalDir, { tenant: PUBLIC_HTTPS_ONLY })
    await store.addServer(HTTPS)

    await expect(
      store.updateServer({ ...NON_DEFAULT_PORT, name: HTTPS.name }),
    ).rejects.toBeInstanceOf(InvalidServerRecordError)
    expect(await store.getServer(HTTPS.name)).toEqual(HTTPS)
  })

  test('without tenant mode, a non-443 port is unaffected', async () => {
    const store = createRegistryStore(journalDir)

    await expect(store.addServer(NON_DEFAULT_PORT)).resolves.toEqual(NON_DEFAULT_PORT)
  })
})

describe('registry: server count limit', () => {
  function httpsServer(index: number): ServerRecord {
    return { name: `server-${index}`, transport: 'http', url: `https://example.com/${index}`, protocol: 'auto' }
  }

  test('the 5th server is OK, the 6th is refused with the fixed message, document stays readable', async () => {
    const tenant = withLimits({ servers: 5, agents: 5, groups: 2, requestsPerSecond: 10, requestsPerDay: 10_000 })
    const store = createRegistryStore(journalDir, { tenant })

    for (let index = 0; index < 5; index += 1) {
      await store.addServer(httpsServer(index))
    }
    expect((await store.listServers()).length).toBe(5)

    const refused = store.addServer(httpsServer(5))
    await expect(refused).rejects.toBeInstanceOf(TooManyServersError)
    await expect(refused).rejects.toThrow('too many servers: max 5 (tenant mode)')
    expect((await store.listServers()).length).toBe(5)
  })

  test('an oversized document (written before the limit was turned on) stays readable', async () => {
    // Arrange — no tenant mode yet: write 7 records.
    const unrestricted = createRegistryStore(journalDir)
    for (let index = 0; index < 7; index += 1) {
      await unrestricted.addServer(httpsServer(index))
    }

    // Act — a fresh store, now with a limit of 5, opens over the same document.
    const tenant = withLimits({ servers: 5, agents: 5, groups: 2, requestsPerSecond: 10, requestsPerDay: 10_000 })
    const gated = createRegistryStore(journalDir, { tenant })

    // Assert — reading never fails; only a NEW write would be refused.
    await expect(gated.listServers()).resolves.toHaveLength(7)
    await expect(gated.getServer('server-0')).resolves.toBeDefined()
  })
})

describe('registry: no tenant section means prior behavior', () => {
  test('stdio and plain http both succeed, no count gate below 200', async () => {
    const store = createRegistryStore(journalDir)

    await expect(store.addServer(STDIO)).resolves.toEqual(STDIO)
    await expect(store.addServer(PLAIN_HTTP)).resolves.toEqual(PLAIN_HTTP)
    expect((await store.listServers()).length).toBe(2)
  })
})

describe('agents: count limit', () => {
  test('the 5th agent is OK, the 6th is refused with the fixed message', async () => {
    const tenant = withLimits({ servers: 5, agents: 5, groups: 2, requestsPerSecond: 10, requestsPerDay: 10_000 })
    const store = createAgentsStore({ journalDir, tenant })

    for (let index = 0; index < 5; index += 1) {
      await store.createAgent(`agent-${index}`)
    }
    expect((await store.listAgents()).length).toBe(5)

    const refused = store.createAgent('one-too-many')
    await expect(refused).rejects.toBeInstanceOf(TooManyAgentsError)
    await expect(refused).rejects.toThrow('too many agents: max 5 (tenant mode)')
    expect((await store.listAgents()).length).toBe(5)
  })

  test('without tenant mode, the 6th agent still succeeds', async () => {
    const store = createAgentsStore({ journalDir })
    for (let index = 0; index < 5; index += 1) {
      await store.createAgent(`agent-${index}`)
    }

    await expect(store.createAgent('agent-5')).resolves.toBeDefined()
  })
})

describe('groups: count limit', () => {
  test('the 2nd group is OK, the 3rd is refused with the fixed message', async () => {
    const tenant = withLimits({ servers: 5, agents: 5, groups: 2, requestsPerSecond: 10, requestsPerDay: 10_000 })
    const store = createGroupsStore({ journalDir, tenant })

    await store.createGroup('group-0')
    await store.createGroup('group-1')
    expect((await store.listGroups()).length).toBe(2)

    const refused = store.createGroup('one-too-many')
    await expect(refused).rejects.toBeInstanceOf(TooManyGroupsError)
    await expect(refused).rejects.toThrow('too many groups: max 2 (tenant mode)')
    expect((await store.listGroups()).length).toBe(2)
  })

  test('without tenant mode, the 3rd group still succeeds', async () => {
    const store = createGroupsStore({ journalDir })
    await store.createGroup('group-0')
    await store.createGroup('group-1')

    await expect(store.createGroup('group-2')).resolves.toBeDefined()
  })
})
