import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * `JsonStore.update` may re-run its callback when it loses the optimistic
 * revision CAS on the SQLite-backed store (`src/policy/store.ts`): a
 * concurrent writer commits first, and the losing attempt re-runs `fn`
 * against the winner's now-committed value rather than the stale one it
 * started with. Registry mutations that report their outcome through a
 * captured variable are the shape that breaks under that replay, and
 * `removeServer` broke: it recorded the record found on the first attempt
 * and never cleared it, so a retry that no longer found the server still
 * reported a removal. For a control plane whose journal is the product, a
 * false "removed" is worse than a failure.
 *
 * The replay is injected rather than raced: `update` here calls the callback
 * twice, the second time against a registry the first attempt's "concurrent
 * writer" already emptied. Racing a real CAS conflict would reproduce it
 * only intermittently, which is exactly how it slipped through.
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
  createJsonStore: () => {
    let attempt = 0
    return {
      read: async () => structuredClone(REGISTRY_WITH_SERVER),
      update: async (fn: (current: unknown) => unknown) => {
        // Attempt 1 sees the server; its CAS then loses to a concurrent
        // writer that removes the server itself, so attempt 2 re-runs `fn`
        // against that writer's committed (now empty) registry.
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
