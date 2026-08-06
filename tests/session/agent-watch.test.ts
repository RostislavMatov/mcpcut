import { describe, expect, test } from 'vitest'
import type { AgentRecord } from '../../src/agents/schema.js'
import { isRevokedFor, startAgentWatch } from '../../src/session/agent-watch.js'

/**
 * Direct unit tests for the session's agent-authorization watch. The
 * end-to-end behavior (revocation ends a live session, grant edits apply on
 * the next call) is covered in `core.test.ts`; this file pins the pieces.
 */

const SERVER_NAME = 'testsrv'

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
    const watch = startAgentWatch({
      record: recordOf(),
      serverName: SERVER_NAME,
      store: { getAgent: () => Promise.resolve(undefined) }, // would revoke on first poll
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
    await sleep(50)

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
    await sleep(30)
    watch.stop()

    expect(errors.length).toBeGreaterThan(0)
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
