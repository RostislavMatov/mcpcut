import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * `JsonStore.update` may re-run its callback when it loses the optimistic
 * revision CAS on the SQLite-backed store (`src/policy/store.ts`): a
 * concurrent writer commits first, and the losing attempt re-runs `fn`
 * against the winner's now-committed value rather than the stale one it
 * started with. `ungrantServerEverywhere` reports its outcome through a
 * captured variable — the exact shape that breaks under that replay if the
 * capture is not reset per attempt (see `tests/registry/store-replay.test.ts`
 * for the bug this mirrors). A cascade that reports agents it never touched
 * would put a false "access revoked" line in front of the operator.
 *
 * The replay is injected rather than raced: `update` here calls the callback
 * twice, the second time against a file whose grant the first attempt's
 * "concurrent writer" already removed. Racing a real CAS conflict would
 * reproduce it only intermittently.
 */

interface AgentLike {
  readonly name: string
  readonly grants: Readonly<Record<string, unknown>>
}

interface AgentsFileLike {
  readonly version: 1
  readonly agents: Readonly<Record<string, AgentLike>>
}

const attempts = vi.hoisted(() => ({
  calls: [] as { readonly input: unknown; readonly output: unknown }[],
}))

const AGENTS_WITH_GRANT: AgentsFileLike = {
  version: 1,
  agents: {
    alpha: {
      name: 'alpha',
      grants: { github: { tools: '*' } },
    },
    charlie: {
      name: 'charlie',
      grants: { jira: { tools: ['read_issue'] } },
    },
  },
}

const AGENTS_WITHOUT_GRANT: AgentsFileLike = {
  version: 1,
  agents: {
    alpha: { name: 'alpha', grants: {} },
    charlie: { name: 'charlie', grants: { jira: { tools: ['read_issue'] } } },
  },
}

vi.mock('../../src/policy/store.js', () => ({
  StoreCorruptError: class extends Error {},
  StoreLockError: class extends Error {},
  createJsonStore: () => ({
    read: async () => structuredClone(AGENTS_WITH_GRANT),
    update: async (fn: (current: unknown) => unknown) => {
      // Attempt 1 sees the grant; its CAS then loses to a concurrent writer
      // that removed the very same grant, so attempt 2 re-runs `fn` against
      // that writer's committed value.
      const first = structuredClone(AGENTS_WITH_GRANT)
      attempts.calls.push({ input: first, output: fn(first) })
      const second = structuredClone(AGENTS_WITHOUT_GRANT)
      const output = fn(second)
      attempts.calls.push({ input: second, output })
      return output
    },
  }),
}))

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-agents-replay-'))
  attempts.calls.length = 0
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

describe('agent cascade survives an update() replay', () => {
  test('ungrantServerEverywhere reports the LAST attempt, not the first', async () => {
    const { createAgentsStore } = await import('../../src/agents/store.js')
    const store = createAgentsStore({ journalDir })

    const affected = await store.ungrantServerEverywhere('github')

    expect(affected).toEqual([])
  })

  test('records without the grant are carried over by reference, not rebuilt', async () => {
    const { createAgentsStore } = await import('../../src/agents/store.js')
    const store = createAgentsStore({ journalDir })

    await store.ungrantServerEverywhere('github')

    const first = attempts.calls[0] as {
      readonly input: AgentsFileLike
      readonly output: AgentsFileLike
    }
    expect(first.output.agents['charlie']).toBe(first.input.agents['charlie'])
    expect(first.output.agents['alpha']).not.toBe(first.input.agents['alpha'])
  })
})
