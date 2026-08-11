import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * `JsonStore.update` may re-run its callback when a concurrent process steals
 * the store lock mid-flight (see `src/lockfile.ts`). Registry mutations that
 * report their outcome through a captured variable are the shape that breaks
 * under that replay, and `removeServer` broke: it recorded the record found on
 * the first attempt and never cleared it, so a retry that no longer found the
 * server still reported a removal. For a control plane whose journal is the
 * product, a false "removed" is worse than a failure.
 *
 * The replay is injected rather than raced: `update` here calls the callback
 * twice, the second time against a registry the first attempt's "concurrent
 * holder" already emptied. Racing a real lock steal would reproduce it only
 * intermittently, which is exactly how it slipped through.
 */

const REGISTRY_WITH_SERVER = {
  version: 1 as const,
  servers: {
    github: {
      name: 'github',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {},
    },
  },
}

const EMPTY_REGISTRY = { version: 1 as const, servers: {} }

vi.mock('../../src/policy/store.js', () => ({
  StoreCorruptError: class extends Error {},
  StoreLockError: class extends Error {},
  StoreLockLostError: class extends Error {},
  createJsonStore: () => {
    let attempt = 0
    return {
      read: async () => structuredClone(REGISTRY_WITH_SERVER),
      update: async (fn: (current: unknown) => unknown) => {
        // Attempt 1 sees the server; its lock is then stolen by a holder that
        // removes the server itself, so attempt 2 sees an empty registry.
        attempt += 1
        fn(structuredClone(REGISTRY_WITH_SERVER))
        attempt += 1
        return fn(structuredClone(EMPTY_REGISTRY))
      },
    }
  },
}))

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-registry-replay-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('registry mutations survive an update() replay', () => {
  test('removeServer reports not-found when the retry no longer sees the server', async () => {
    const { createRegistryStore } = await import('../../src/registry/store.js')
    const store = createRegistryStore(dir)

    const result = await store.removeServer('github')

    expect(result).toEqual({ status: 'not-found' })
  })
})
