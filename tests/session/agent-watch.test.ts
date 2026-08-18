import { describe, expect, test, vi } from 'vitest'
import type { AgentRecord } from '../../src/agents/schema.js'
import { isRevokedFor, startAgentWatch } from '../../src/session/agent-watch.js'

/**
 * Direct unit tests for the session's agent-authorization watch. The
 * end-to-end behavior (revocation ends a live session, grant edits apply on
 * the next call) is covered in `core.test.ts`; this file pins the pieces.
 */

/**
 * Counts real `grantsHashOf` calls without changing what it returns, so the
 * "polls do no hashing work" claim can be asserted rather than assumed
 * (review finding 6). Everything else in the module is passed through.
 */
const hashCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('../../src/policy/provenance.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/policy/provenance.js')>()
  return {
    ...actual,
    grantsHashOf: (grants: Readonly<Record<string, unknown>>) => {
      hashCalls.count += 1
      return actual.grantsHashOf(grants)
    },
  }
})

const { grantsHashOf } = await import('../../src/policy/provenance.js')

const SERVER_NAME = 'testsrv'

/** Generous ceiling for "this was never going to happen"; never a delay that is waited out. */
const OBSERVE_TIMEOUT_MS = 5_000

function recordOf(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name: 'research-bot',
    tokenHash: 'a'.repeat(64),
    createdAt: '2026-08-01T00:00:00.000Z',
    grants: { [SERVER_NAME]: { tools: ['read_*'] } },
    ...overrides,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Polls for an observed condition with a deadline, rather than sleeping past
 * a guessed wall-clock duration: a fixed `sleep(30)` against a 5 ms poll is a
 * race that a loaded CI box loses first (TS-L4).
 */
async function waitUntil(describeWhat: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + OBSERVE_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${describeWhat}`)
    await sleep(1)
  }
}

describe('isRevokedFor', () => {
  test.each([
    ['a missing record', undefined, true],
    ['a revoked record', recordOf({ revokedAt: '2026-08-06T00:00:00.000Z' }), true],
    ['a record without a grant for this server', recordOf({ grants: {} }), true],
    ['a live record with the grant', recordOf(), false],
  ])('%s', (_label, record, expected) => {
    expect(isRevokedFor(record, SERVER_NAME)).toBe(expected)
  })
})

describe('startAgentWatch', () => {
  test('the scope delegates to the initial record before any poll', () => {
    const watch = startAgentWatch({
      record: recordOf(),
      serverName: SERVER_NAME,
      store: { getAgent: () => Promise.resolve(recordOf()) },
      pollIntervalMs: 10_000,
      onRevoked: () => undefined,
      onError: () => undefined,
    })

    expect(watch.scope.agentName).toBe('research-bot')
    expect(watch.scope.isGranted('read_file')).toBe(true)
    expect(watch.scope.isGranted('write_file')).toBe(false)
    expect(watch.scope.filterVisible(['read_file', 'write_file'])).toEqual(['read_file'])

    watch.stop()
  })

  test('start is idempotent and stop prevents any further revocation callback', async () => {
    let revoked = 0
    let reads = 0
    const watch = startAgentWatch({
      record: recordOf(),
      serverName: SERVER_NAME,
      store: {
        getAgent: () => {
          reads += 1
          return Promise.resolve(undefined) // would revoke on the first poll
        },
      },
      pollIntervalMs: 5,
      onRevoked: () => {
        revoked += 1
      },
      onError: () => undefined,
    })

    watch.start()
    watch.start() // second start must not double the timer
    watch.stop()
    await sleep(30)

    expect(reads).toBe(0)
    expect(revoked).toBe(0)
  })

  test('onRevoked fires at most once even with fast polls', async () => {
    let revoked = 0
    const watch = startAgentWatch({
      record: recordOf(),
      serverName: SERVER_NAME,
      store: { getAgent: () => Promise.resolve(undefined) },
      pollIntervalMs: 5,
      onRevoked: () => {
        revoked += 1
      },
      onError: () => undefined,
    })

    watch.start()
    await waitUntil('the revocation callback to fire', () => revoked > 0)
    // It fired; the point of the test is that further polls cannot repeat it.
    await sleep(30)

    expect(revoked).toBe(1)
  })

  test('a failing store is reported and the last scope survives', async () => {
    const errors: unknown[] = []
    const watch = startAgentWatch({
      record: recordOf(),
      serverName: SERVER_NAME,
      store: { getAgent: () => Promise.reject(new Error('locked')) },
      pollIntervalMs: 5,
      onRevoked: () => {
        throw new Error('must not be called on a read failure')
      },
      onError: (error) => errors.push(error),
    })

    watch.start()
    await waitUntil('the read failure to be reported', () => errors.length > 0)
    watch.stop()

    expect(watch.scope.isGranted('read_file')).toBe(true)
  })

  test('a stopped watch cannot be restarted', async () => {
    let revoked = 0
    const watch = startAgentWatch({
      record: recordOf(),
      serverName: SERVER_NAME,
      store: { getAgent: () => Promise.resolve(undefined) },
      pollIntervalMs: 5,
      onRevoked: () => {
        revoked += 1
      },
      onError: () => undefined,
    })

    watch.stop()
    watch.start()
    await sleep(30)

    expect(revoked).toBe(0)
  })
})

/**
 * Grant-matrix provenance (M5 wave 1). The watch is the only thing that
 * knows the agent's matrix changed, so it owns the fingerprint the gate
 * stamps on decision records. The whole `record.grants` object is hashed --
 * the agent's full matrix, not just this server's slice -- so a record can
 * be tied back to one identifiable version of the agent's authorization.
 */
describe('startAgentWatch: grants provenance', () => {
  interface CountingStore {
    getAgent: () => Promise<AgentRecord | undefined>
    readCount: () => number
  }

  function countingStore(getAgent: () => Promise<AgentRecord | undefined>): CountingStore {
    let reads = 0
    return {
      getAgent: () => {
        reads += 1
        return getAgent()
      },
      readCount: () => reads,
    }
  }

  function watchOver(
    initial: AgentRecord,
    store: CountingStore,
    onError: (error: unknown) => void = () => undefined,
  ) {
    return startAgentWatch({
      record: initial,
      serverName: SERVER_NAME,
      store: { getAgent: store.getAgent },
      pollIntervalMs: 5,
      onRevoked: () => undefined,
      onError,
    })
  }

  /** Runs `watch` until at least `polls` store reads have completed. */
  async function afterPolls(watch: { start(): void; stop(): void }, store: CountingStore, polls: number): Promise<void> {
    watch.start()
    await waitUntil(`${polls} completed poll(s)`, () => store.readCount() >= polls)
    watch.stop()
  }

  test("the scope reports the initial record's grants fingerprint before any poll", () => {
    const record = recordOf()
    const watch = watchOver(record, countingStore(() => Promise.resolve(record)))

    expect(watch.scope.grantsHash()).toBe(grantsHashOf(record.grants))

    watch.stop()
  })

  test('a poll that swaps the scope changes the fingerprint', async () => {
    const widened = recordOf({ grants: { [SERVER_NAME]: { tools: ['read_*', 'write_file'] } } })
    const store = countingStore(() => Promise.resolve(widened))
    const watch = watchOver(recordOf(), store)

    const before = watch.scope.grantsHash()
    watch.start()
    await waitUntil('the widened grant to apply', () => watch.scope.isGranted('write_file'))
    watch.stop()

    expect(before).toBe(grantsHashOf(recordOf().grants))
    expect(watch.scope.grantsHash()).toBe(grantsHashOf(widened.grants))
  })

  test('the scope and its fingerprint move in the same step, never one without the other', () => {
    // Lockstep (review L3): the two used to be two assignments with a window
    // between them, where the new scope decided calls while the old
    // fingerprint was stamped. They are one immutable state object now, so
    // the instant the new grant is observable the new fingerprint already is
    // -- asserted at the FIRST observation of the swap, with no sleep after.
    const widened = recordOf({ grants: { [SERVER_NAME]: { tools: ['read_*', 'write_file'] } } })
    const store = countingStore(() => Promise.resolve(widened))
    const watch = watchOver(recordOf(), store)

    watch.start()
    return waitUntil('the widened grant to apply', () => watch.scope.isGranted('write_file')).then(
      () => {
        expect(watch.scope.grantsHash()).toBe(grantsHashOf(widened.grants))
        watch.stop()
      },
    )
  })

  test('a grant edit on another server still moves the fingerprint', async () => {
    // The full matrix is hashed, so widening the agent elsewhere is visible
    // in this session's records too -- provenance identifies the agent's
    // authorization as a whole, not one slice of it.
    const elsewhere = recordOf({
      grants: { [SERVER_NAME]: { tools: ['read_*'] }, other: { tools: ['*'] } },
    })
    const store = countingStore(() => Promise.resolve(elsewhere))
    const watch = watchOver(recordOf(), store)

    const before = watch.scope.grantsHash()
    await afterPolls(watch, store, 1)

    expect(watch.scope.grantsHash()).not.toBe(before)
    expect(watch.scope.grantsHash()).toBe(grantsHashOf(elsewhere.grants))
  })

  test('a poll that reads the same grants leaves the fingerprint unchanged', async () => {
    const store = countingStore(() => Promise.resolve(recordOf()))
    const watch = watchOver(recordOf(), store)

    const before = watch.scope.grantsHash()
    await afterPolls(watch, store, 2)

    expect(watch.scope.grantsHash()).toBe(before)
  })

  test('a failing poll keeps the last known-good fingerprint', async () => {
    // Authorization never widens on a read error, and neither does the
    // provenance that claims to describe it.
    const errors: unknown[] = []
    const store = countingStore(() => Promise.reject(new Error('locked')))
    const watch = watchOver(recordOf(), store, (error) => errors.push(error))

    const before = watch.scope.grantsHash()
    watch.start()
    await waitUntil('the read failure to be reported', () => errors.length > 0)
    watch.stop()

    expect(watch.scope.grantsHash()).toBe(before)
  })
})

/**
 * The fingerprint is LAZY and memoized (review finding 6). Before this, every
 * poll canonicalized and hashed the agent's whole matrix -- synchronously, on
 * the event loop that gates live traffic, every few seconds per session,
 * whether or not any decision record was written. The schema-permitted worst
 * case for one agent is ~100 MB of serialized JSON, so the amplification is
 * worth measuring rather than assuming.
 */
describe('startAgentWatch: the fingerprint costs nothing until it is read', () => {
  function watchReturning(record: AgentRecord, served: () => AgentRecord) {
    let reads = 0
    const watch = startAgentWatch({
      record,
      serverName: SERVER_NAME,
      store: {
        getAgent: () => {
          reads += 1
          return Promise.resolve(served())
        },
      },
      pollIntervalMs: 5,
      onRevoked: () => undefined,
      onError: () => undefined,
    })
    return { watch, readCount: () => reads }
  }

  test('constructing a watch hashes nothing', () => {
    const before = hashCalls.count
    const { watch } = watchReturning(recordOf(), () => recordOf())

    expect(hashCalls.count - before).toBe(0)

    watch.stop()
  })

  test('polls that nobody asks about hash nothing', async () => {
    const { watch, readCount } = watchReturning(recordOf(), () => recordOf())

    const before = hashCalls.count
    watch.start()
    await waitUntil('three completed polls', () => readCount() >= 3)
    watch.stop()

    expect(hashCalls.count - before).toBe(0)
  })

  test('the first read computes it and every later read reuses it', () => {
    const { watch } = watchReturning(recordOf(), () => recordOf())

    const before = hashCalls.count
    const first = watch.scope.grantsHash()
    const second = watch.scope.grantsHash()
    const third = watch.scope.grantsHash()

    expect(hashCalls.count - before).toBe(1)
    expect(second).toBe(first)
    expect(third).toBe(first)

    watch.stop()
  })

  test('a scope swap invalidates the memo, so no read can serve a stale fingerprint', async () => {
    // The failure mode memoization must not introduce: a cached value
    // outliving the matrix it describes would be worse than recomputing.
    const widened = recordOf({ grants: { [SERVER_NAME]: { tools: ['read_*', 'write_file'] } } })
    let served = recordOf()
    const { watch } = watchReturning(recordOf(), () => served)

    const stale = watch.scope.grantsHash()
    served = widened
    watch.start()
    await waitUntil('the widened grant to apply', () => watch.scope.isGranted('write_file'))
    watch.stop()

    // Computed BEFORE the counter is snapshotted: the test's own expectation
    // goes through the same counting wrapper the watch does.
    const expected = grantsHashOf(widened.grants)
    const before = hashCalls.count
    const fresh = watch.scope.grantsHash()

    // Recomputed exactly once for the new state, then memoized again.
    expect(hashCalls.count - before).toBe(1)
    expect(watch.scope.grantsHash()).toBe(fresh)
    expect(fresh).not.toBe(stale)
    expect(fresh).toBe(expected)
  })
})
