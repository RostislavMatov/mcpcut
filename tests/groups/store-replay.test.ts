import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * `JsonStore.update` may re-run its callback when it loses the optimistic
 * revision CAS on the SQLite-backed store (`src/policy/store.ts`): a
 * concurrent writer commits first, and the losing attempt re-runs `fn`
 * against the winner's now-committed value. Every groups mutation that
 * reports its outcome through a captured variable — `removeGroup` and
 * `ungrantServerEverywhere` — must therefore RESET that variable at the top
 * of each attempt, exactly like `registry.removeServer` (whose missing reset
 * was a real bug: see `tests/registry/store-replay.test.ts`). For a control
 * plane whose journal is the product, a false "removed"/"cascaded" is worse
 * than a failure.
 *
 * The replay is injected rather than raced: `update` calls the callback
 * twice, the second time against the value a "concurrent writer" committed.
 */

const CREATED = '2026-08-31T12:00:00.000Z'

const state = vi.hoisted(() => ({ second: null as unknown }))

const GROUP_WITH_GRANT = {
  version: 1 as const,
  groups: {
    analytics: {
      name: 'analytics',
      createdAt: CREATED,
      grants: { postgres: { tools: '*' as const } },
      members: [] as string[],
    },
  },
}

const NO_GROUPS = { version: 1 as const, groups: {} }

const GROUP_WITHOUT_GRANT = {
  version: 1 as const,
  groups: { analytics: { ...GROUP_WITH_GRANT.groups.analytics, grants: {} } },
}

vi.mock('../../src/policy/store.js', () => ({
  StoreCorruptError: class extends Error {},
  StoreLockError: class extends Error {},
  createJsonStore: () => ({
    read: async () => structuredClone(GROUP_WITH_GRANT),
    update: async (fn: (current: unknown) => unknown) => {
      // Attempt 1 sees the group and its grant; its CAS then loses to a
      // concurrent writer, so attempt 2 re-runs `fn` against what that
      // writer committed.
      fn(structuredClone(GROUP_WITH_GRANT))
      return fn(structuredClone(state.second))
    },
  }),
}))

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-groups-replay-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

describe('groups mutations survive an update() replay', () => {
  test('removeGroup reports not-found when the retry no longer sees the group', async () => {
    state.second = NO_GROUPS
    const { createGroupsStore } = await import('../../src/groups/store.js')
    const store = createGroupsStore({ journalDir })

    expect(await store.removeGroup('analytics')).toEqual({ status: 'not-found' })
  })

  test('removeGroup reports has-members only from the LAST attempt', async () => {
    state.second = {
      version: 1,
      groups: { analytics: { ...GROUP_WITH_GRANT.groups.analytics, members: ['bot-a'] } },
    }
    const { createGroupsStore } = await import('../../src/groups/store.js')
    const store = createGroupsStore({ journalDir })

    expect(await store.removeGroup('analytics')).toEqual({
      status: 'has-members',
      members: ['bot-a'],
    })
  })

  test('ungrantServerEverywhere reports nothing affected when the retry sees no grant', async () => {
    state.second = GROUP_WITHOUT_GRANT
    const { createGroupsStore } = await import('../../src/groups/store.js')
    const store = createGroupsStore({ journalDir })

    expect(await store.ungrantServerEverywhere('postgres')).toEqual([])
  })
})
