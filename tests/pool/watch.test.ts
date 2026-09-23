import { describe, expect, test, vi } from 'vitest'
import type { AgentRecord } from '../../src/agents/schema.js'
import { createPoolWatch, type PoolWatchDeps } from '../../src/pool/watch.js'

/**
 * The watch over what a pool CONTAINS (plan decisions P2, P3).
 *
 * Two things it deliberately does not do. It does not open a server it just
 * saw granted — that stays lazy (PE7); the watch closes what left, tells the
 * agent the list changed, and the next `tools/list` opens the rest. And it
 * does not use `isRevokedFor`, which asks about ONE server: a pool has no
 * server, so losing a grant is a membership change and only a vanished or
 * revoked agent ends the session.
 */

const POLL_MS = 5

function agent(grants: Record<string, unknown>, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name: 'bot',
    tokenHash: 'hash',
    createdAt: '2026-09-22T10:00:00.000Z',
    grants,
    ...overrides,
  } as AgentRecord
}

interface Watched {
  readonly watch: ReturnType<typeof createPoolWatch>
  readonly changed: readonly string[][]
  readonly revoked: { count: number }
  readonly errors: unknown[]
}

function startWatch(
  reads: readonly (() => AgentRecord | undefined)[],
  overrides: Partial<PoolWatchDeps> = {},
): Watched {
  const changed: string[][] = []
  const revoked = { count: 0 }
  const errors: unknown[] = []
  let index = 0

  const watch = createPoolWatch({
    agentName: 'bot',
    initial: (reads[0] as () => AgentRecord)(),
    readAgent: () => {
      index += 1
      const read = reads[Math.min(index, reads.length - 1)]
      return Promise.resolve(read?.())
    },
    pollIntervalMs: POLL_MS,
    onRevoked: () => {
      revoked.count += 1
    },
    onChanged: (granted) => changed.push([...granted]),
    onError: (error) => errors.push(error),
    ...overrides,
  })
  watch.start()
  return { watch, changed, revoked, errors }
}

describe('membership', () => {
  test('starts with the servers the agent was granted, sorted', () => {
    // Arrange / Act
    const watched = startWatch([() => agent({ github: { tools: '*' }, fs: { tools: '*' } })])

    // Assert
    expect(watched.watch.granted).toEqual(['fs', 'github'])
    watched.watch.stop()
  })

  test('says nothing at all when nothing changed', async () => {
    // Otherwise the agent gets a `list_changed` seconds after `initialize`,
    // for no reason it could act on.
    const same = () => agent({ github: { tools: '*' } })
    const watched = startWatch([same])

    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))

    expect(watched.changed).toEqual([])
    watched.watch.stop()
  })

  test('reports a newly granted server', async () => {
    const watched = startWatch([
      () => agent({ github: { tools: '*' } }),
      () => agent({ github: { tools: '*' }, fs: { tools: '*' } }),
    ])

    await vi.waitFor(() => expect(watched.changed).toHaveLength(1))

    expect(watched.changed[0]).toEqual(['fs', 'github'])
    expect(watched.watch.granted).toEqual(['fs', 'github'])
    watched.watch.stop()
  })

  test('reports a revoked server without ending the session', async () => {
    // Losing one grant is a smaller pool, not a closed one — the agent keeps
    // talking to everything else it was granted.
    const watched = startWatch([
      () => agent({ github: { tools: '*' }, fs: { tools: '*' } }),
      () => agent({ github: { tools: '*' } }),
    ])

    await vi.waitFor(() => expect(watched.changed).toHaveLength(1))

    expect(watched.changed[0]).toEqual(['github'])
    expect(watched.revoked.count).toBe(0)
    watched.watch.stop()
  })

  test('reports an edit INSIDE a server, where membership did not move (P2)', async () => {
    // The visible catalog is filtered by grants, so narrowing a server's
    // tools changes what the agent can see just as surely as removing the
    // server does. Watching membership alone would miss it.
    const watched = startWatch([
      () => agent({ github: { tools: ['a', 'b'] } }),
      () => agent({ github: { tools: ['a'] } }),
    ])

    await vi.waitFor(() => expect(watched.changed).toHaveLength(1))

    expect(watched.changed[0]).toEqual(['github'])
    watched.watch.stop()
  })

  test('is not fooled by a grant list written in a different order', async () => {
    // The fingerprint canonicalizes, so a rewritten-but-equivalent matrix is
    // not a change and must not wake the agent.
    const watched = startWatch([
      () => agent({ github: { tools: ['a', 'b'] } }),
      () => agent({ github: { tools: ['b', 'a'] } }),
    ])

    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))

    expect(watched.changed).toEqual([])
    watched.watch.stop()
  })
})

describe('revocation', () => {
  test('ends the session when the agent record is gone', async () => {
    const watched = startWatch([() => agent({ github: { tools: '*' } }), () => undefined])

    await vi.waitFor(() => expect(watched.revoked.count).toBe(1))
    watched.watch.stop()
  })

  test('ends the session when the agent was revoked', async () => {
    const watched = startWatch([
      () => agent({ github: { tools: '*' } }),
      () => agent({ github: { tools: '*' } }, { revokedAt: '2026-09-22T11:00:00.000Z' }),
    ])

    await vi.waitFor(() => expect(watched.revoked.count).toBe(1))
    watched.watch.stop()
  })

  test('stops polling once it has revoked', async () => {
    const watched = startWatch([() => agent({ github: { tools: '*' } }), () => undefined])

    await vi.waitFor(() => expect(watched.revoked.count).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 5))

    expect(watched.revoked.count).toBe(1)
  })
})

describe('failure', () => {
  test('a read that threw does not narrow the pool', async () => {
    // Fail closed means "no new access", not "less access": a store that is
    // briefly unreadable must not tear an agent's servers away from it.
    let calls = 0
    const changed: string[][] = []
    const errors: unknown[] = []
    const watch = createPoolWatch({
      agentName: 'bot',
      initial: agent({ github: { tools: '*' }, fs: { tools: '*' } }),
      readAgent: () => {
        calls += 1
        return calls === 1
          ? Promise.reject(new Error('store unreadable'))
          : Promise.resolve(agent({ github: { tools: '*' }, fs: { tools: '*' } }))
      },
      pollIntervalMs: POLL_MS,
      onRevoked: () => undefined,
      onChanged: (granted) => changed.push([...granted]),
      onError: (error) => errors.push(error),
    })
    watch.start()

    await vi.waitFor(() => expect(errors).toHaveLength(1))

    expect(watch.granted).toEqual(['fs', 'github'])
    expect(changed).toEqual([])
    // And the watch keeps working afterwards.
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 3))
    expect(watch.granted).toEqual(['fs', 'github'])
    watch.stop()
  })

  test('a stop during a poll discards that poll outcome', async () => {
    let release: ((record: AgentRecord) => void) | null = null
    const changed: string[][] = []
    const watch = createPoolWatch({
      agentName: 'bot',
      initial: agent({ github: { tools: '*' } }),
      readAgent: () =>
        new Promise<AgentRecord>((resolve) => {
          release = resolve
        }),
      pollIntervalMs: POLL_MS,
      onRevoked: () => undefined,
      onChanged: (granted) => changed.push([...granted]),
      onError: () => undefined,
    })
    watch.start()

    await vi.waitFor(() => expect(release).not.toBeNull())
    watch.stop()
    release?.(agent({ github: { tools: '*' }, fs: { tools: '*' } }))
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 3))

    expect(changed).toEqual([])
    expect(watch.granted).toEqual(['github'])
  })
})
