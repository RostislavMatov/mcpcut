import { describe, expect, test } from 'vitest'
import { buildPoolRecord, type PoolRecordInfo } from '../../src/journal/pool-record.js'
import type { JournalRecord } from '../../src/journal/record.js'
import {
  childBindingsOf,
  childrenOutsideExport,
  createPoolLedger,
  MAX_SUMMARY_POOL_EVENTS,
  MAX_SUMMARY_POOL_SESSIONS,
} from '../../src/journal/report-pools.js'

/**
 * The pool ledger of an audit report (ADR-0015, phase 5, R1/R2/R5): what the
 * export's single pass learns about pool sessions from their `kind:'pool'`
 * records. Every record here is built by the PRODUCT's own `buildPoolRecord`,
 * so the shape under test is the shape the journal really holds; the hostile
 * cases then take that record apart.
 */

let tick = 0
const clock = (): number => Date.parse('2026-09-23T10:00:00.000Z') + tick++ * 1000

function poolRecord(sessionId: string, pool: PoolRecordInfo): JournalRecord {
  return buildPoolRecord({ sessionId, pool, clock })
}

function withPayload(payload: unknown): JournalRecord {
  return { ...poolRecord('pool-x', { agentName: 'bot', event: 'open' }), payload }
}

function feed(records: readonly JournalRecord[], limits?: { maxSessions?: number; maxEvents?: number }) {
  const ledger = createPoolLedger(limits)
  for (const record of records) ledger.take(record)
  return ledger.tally()
}

describe('createPoolLedger', () => {
  test('keeps pool sessions in order of first appearance and children in journal order', () => {
    const tally = feed([
      poolRecord('pool-b', { agentName: 'bot-b', event: 'open', members: ['alpha'] }),
      poolRecord('pool-a', { agentName: 'bot-a', event: 'open', members: ['beta'] }),
      poolRecord('pool-a', { agentName: 'bot-a', event: 'attach', serverName: 'beta', childSessionId: 'c-2' }),
      poolRecord('pool-b', { agentName: 'bot-b', event: 'attach', serverName: 'alpha', childSessionId: 'c-1' }),
      poolRecord('pool-b', { agentName: 'bot-b', event: 'attach', serverName: 'gamma', childSessionId: 'c-3' }),
      poolRecord('pool-b', { agentName: 'bot-b', event: 'close' }),
    ])

    expect(tally.sessions.map((session) => session.sessionId)).toEqual(['pool-b', 'pool-a'])
    const first = tally.sessions[0]
    expect(first?.agentNames).toEqual(['bot-b'])
    expect(first?.children.map((child) => [child.serverName, child.childSessionId])).toEqual([
      ['alpha', 'c-1'],
      ['gamma', 'c-3'],
    ])
    expect(first?.openedAt).toBeDefined()
    expect(first?.closedAt).toBeDefined()
    expect(tally.sessions[1]?.closedAt).toBeUndefined()
    expect(tally.omittedRecordCount).toBe(0)
    expect(tally.unreadableCount).toBe(0)
  })

  test('keeps the first open and the last close of a session', () => {
    const records = [
      poolRecord('pool-a', { agentName: 'bot', event: 'open' }),
      poolRecord('pool-a', { agentName: 'bot', event: 'open' }),
      poolRecord('pool-a', { agentName: 'bot', event: 'close' }),
      poolRecord('pool-a', { agentName: 'bot', event: 'close' }),
    ]

    const session = feed(records).sessions[0]

    expect(session?.openedAt).toBe(records[0]?.ts)
    expect(session?.closedAt).toBe(records[3]?.ts)
  })

  test('shows both children of a server that reconnected, and why it left in between', () => {
    const tally = feed([
      poolRecord('pool-a', { agentName: 'bot', event: 'attach', serverName: 'memory', childSessionId: 'c-2' }),
      poolRecord('pool-a', { agentName: 'bot', event: 'detach', serverName: 'memory', reason: 'ungranted' }),
      poolRecord('pool-a', { agentName: 'bot', event: 'attach', serverName: 'memory', childSessionId: 'c-5' }),
    ])

    const session = tally.sessions[0]
    expect(session?.children.map((child) => child.childSessionId)).toEqual(['c-2', 'c-5'])
    expect(session?.detached).toEqual([{ serverName: 'memory', reason: 'ungranted' }])
  })

  test('records refusals and a departure that carries no reason', () => {
    const tally = feed([
      poolRecord('pool-a', { agentName: 'bot', event: 'attach-refused', serverName: 'http', reason: 'handshake-failed' }),
      poolRecord('pool-a', { agentName: 'bot', event: 'detach', serverName: 'memory' }),
    ])

    const session = tally.sessions[0]
    expect(session?.refused).toEqual([{ serverName: 'http', reason: 'handshake-failed' }])
    expect(session?.detached).toEqual([{ serverName: 'memory' }])
  })

  test('counts dropped frames per reason with keys in plain code-unit order', () => {
    const tally = feed([
      poolRecord('pool-a', { agentName: 'bot', event: 'dropped', reason: 'unsupported-method' }),
      poolRecord('pool-a', { agentName: 'bot', event: 'dropped', reason: 'name-too-long' }),
      poolRecord('pool-a', { agentName: 'bot', event: 'dropped', reason: 'name-too-long' }),
      poolRecord('pool-a', { agentName: 'bot', event: 'dropped', reason: 'Zeta' }),
    ])

    const dropped = tally.sessions[0]?.dropped ?? {}
    expect(Object.keys(dropped)).toEqual(['Zeta', 'name-too-long', 'unsupported-method'])
    expect(dropped).toEqual({ 'name-too-long': 2, 'unsupported-method': 1, Zeta: 1 })
  })

  test('keeps a dropped reason named __proto__ as an ordinary key through JSON', () => {
    const tally = feed([poolRecord('pool-a', { agentName: 'bot', event: 'dropped', reason: '__proto__' })])

    const roundTrip = JSON.parse(JSON.stringify(tally)) as { sessions: { dropped: Record<string, number> }[] }
    expect(Object.hasOwn(roundTrip.sessions[0]?.dropped ?? {}, '__proto__')).toBe(true)
    expect(roundTrip.sessions[0]?.dropped['__proto__']).toBe(1)
  })

  test('names every agent a session was journaled under -- a forgery is shown, not resolved', () => {
    const tally = feed([
      poolRecord('pool-a', { agentName: 'bot', event: 'open' }),
      poolRecord('pool-a', { agentName: 'mallory', event: 'close' }),
      poolRecord('pool-a', { agentName: 'bot', event: 'close' }),
    ])

    expect(tally.sessions[0]?.agentNames).toEqual(['bot', 'mallory'])
  })

  test('reads a membership change without reporting anything from it', () => {
    const tally = feed([
      poolRecord('pool-a', { agentName: 'bot', event: 'members-changed', members: ['alpha', 'beta'] }),
    ])

    expect(tally.sessions).toHaveLength(1)
    expect(tally.sessions[0]?.children).toEqual([])
    expect(tally.unreadableCount).toBe(0)
  })

  test('ignores every record that is not a pool record', () => {
    const record = poolRecord('pool-a', { agentName: 'bot', event: 'open' })

    const tally = feed([{ ...record, kind: 'decision' }, { ...record, kind: 'request' }])

    expect(tally.sessions).toEqual([])
    expect(tally.unreadableCount).toBe(0)
  })

  test('counts a pool record whose payload cannot be read, and reports no session from it', () => {
    const attach = poolRecord('pool-x', { agentName: 'bot', event: 'attach', serverName: 'alpha', childSessionId: 'c' })
    const noChild = { ...attach, payload: { agentName: 'bot', event: 'attach', serverName: 'alpha' } }

    const tally = feed([
      withPayload(null),
      withPayload([]),
      withPayload('x'),
      withPayload({ agentName: 'bot', event: 'bogus' }),
      withPayload({ agentName: 'bot', event: '__proto__' }),
      noChild,
    ])

    expect(tally.unreadableCount).toBe(6)
    expect(tally.sessions).toEqual([])
  })

  test.each([
    ['an empty agent name', { agentName: '', event: 'open' }],
    ['a non-string agent name', { agentName: 7, event: 'open' }],
    ['a non-string server name', { agentName: 'bot', event: 'detach', serverName: 3 }],
    ['a non-string child id', { agentName: 'bot', event: 'attach', serverName: 'a', childSessionId: 3 }],
    ['a non-string reason', { agentName: 'bot', event: 'dropped', reason: { x: 1 } }],
    ['a refusal with no server', { agentName: 'bot', event: 'attach-refused', reason: 'x' }],
    ['a departure with no server', { agentName: 'bot', event: 'detach' }],
    ['a drop with no reason', { agentName: 'bot', event: 'dropped' }],
    ['an inherited event name', { agentName: 'bot', event: 'toString' }],
  ])('treats %s as unreadable', (_label, payload) => {
    const tally = feed([withPayload(payload)])

    expect(tally.unreadableCount).toBe(1)
    expect(tally.sessions).toEqual([])
  })

  test('hands out copies: a tally does not move when the ledger takes more records', () => {
    const ledger = createPoolLedger()
    ledger.take(poolRecord('pool-a', { agentName: 'bot', event: 'attach', serverName: 'a', childSessionId: 'c-1' }))
    const before = ledger.tally()

    ledger.take(poolRecord('pool-a', { agentName: 'bot', event: 'attach', serverName: 'b', childSessionId: 'c-2' }))

    expect(before.sessions[0]?.children).toHaveLength(1)
    expect(Object.isFrozen(before.sessions[0]?.children)).toBe(true)
  })
})

describe('createPoolLedger: memory bounds (R5)', () => {
  test('defaults to the documented caps', () => {
    expect(MAX_SUMMARY_POOL_SESSIONS).toBe(500)
    expect(MAX_SUMMARY_POOL_EVENTS).toBe(5000)
  })

  test('stops keeping sessions past the cap and counts every record it left out', () => {
    const records = [
      poolRecord('pool-1', { agentName: 'bot', event: 'open' }),
      poolRecord('pool-2', { agentName: 'bot', event: 'open' }),
      poolRecord('pool-3', { agentName: 'bot', event: 'open' }),
      poolRecord('pool-3', { agentName: 'bot', event: 'close' }),
      poolRecord('pool-1', { agentName: 'bot', event: 'close' }),
    ]

    const tally = feed(records, { maxSessions: 2 })

    expect(tally.sessions.map((session) => session.sessionId)).toEqual(['pool-1', 'pool-2'])
    expect(tally.sessions[0]?.closedAt).toBeDefined()
    expect(tally.omittedRecordCount).toBe(2)
  })

  test('stops keeping events past the cap, whole records at a time', () => {
    // Budget 3: the agent name (1), the first child (1), the drop reason (1).
    // The second child and the second reason would each spend one more; a
    // repeat of a known reason only moves a counter and spends nothing.
    const records = [
      poolRecord('pool-1', { agentName: 'bot', event: 'attach', serverName: 'a', childSessionId: 'c-1' }),
      poolRecord('pool-1', { agentName: 'bot', event: 'dropped', reason: 'unreadable' }),
      poolRecord('pool-1', { agentName: 'bot', event: 'attach', serverName: 'b', childSessionId: 'c-2' }),
      poolRecord('pool-1', { agentName: 'bot', event: 'dropped', reason: 'unreadable' }),
      poolRecord('pool-1', { agentName: 'bot', event: 'dropped', reason: 'reserved-id' }),
      poolRecord('pool-1', { agentName: 'bot', event: 'close' }),
    ]

    const tally = feed(records, { maxEvents: 3 })

    const session = tally.sessions[0]
    expect(session?.children.map((child) => child.childSessionId)).toEqual(['c-1'])
    expect(session?.dropped).toEqual({ unreadable: 2 })
    expect(session?.closedAt).toBeDefined()
    expect(tally.omittedRecordCount).toBe(2)
  })

  test('holds the default caps exactly', () => {
    const sessions = Array.from({ length: MAX_SUMMARY_POOL_SESSIONS + 1 }, (_, index) =>
      poolRecord(`pool-${index}`, { agentName: 'bot', event: 'open' }),
    )

    expect(feed(sessions).omittedRecordCount).toBe(1)

    const events = Array.from({ length: MAX_SUMMARY_POOL_EVENTS }, (_, index) =>
      poolRecord('pool-1', { agentName: 'bot', event: 'attach', serverName: 's', childSessionId: `c-${index}` }),
    )
    // The first record also spends one event on the agent name.
    expect(feed(events).omittedRecordCount).toBe(1)
  })
})

describe('childBindingsOf', () => {
  test('maps each child session to the pool, server and agents that named it', () => {
    const tally = feed([
      poolRecord('pool-a', { agentName: 'bot', event: 'attach', serverName: 'alpha', childSessionId: 'c-1' }),
      poolRecord('pool-a', { agentName: 'bot', event: 'attach', serverName: 'alpha', childSessionId: 'c-1' }),
    ])

    expect(childBindingsOf(tally).get('c-1')).toEqual([
      { poolSessionId: 'pool-a', serverName: 'alpha', agentNames: ['bot'] },
    ])
  })

  test('keeps both claims when two pool sessions name the same child', () => {
    const tally = feed([
      poolRecord('pool-a', { agentName: 'bot', event: 'attach', serverName: 'alpha', childSessionId: 'c-1' }),
      poolRecord('pool-b', { agentName: 'eve', event: 'attach', serverName: 'beta', childSessionId: 'c-1' }),
    ])

    expect(childBindingsOf(tally).get('c-1')?.map((binding) => binding.poolSessionId)).toEqual([
      'pool-a',
      'pool-b',
    ])
  })
})

describe('childrenOutsideExport (R3)', () => {
  const tally = feed([
    poolRecord('pool-a', { agentName: 'bot', event: 'attach', serverName: 'alpha', childSessionId: 'c-1' }),
    poolRecord('pool-a', { agentName: 'bot', event: 'attach', serverName: 'beta', childSessionId: 'c-2' }),
    poolRecord('pool-a', { agentName: 'bot', event: 'attach', serverName: 'beta', childSessionId: 'c-2' }),
  ])

  test('is empty for an export of the whole journal', () => {
    expect(childrenOutsideExport(tally, { scope: { session: null }, sessionIds: ['pool-a'] })).toEqual([])
  })

  test('names every child of the exported pool session that the export leaves out, once each', () => {
    expect(childrenOutsideExport(tally, { scope: { session: 'pool-a' }, sessionIds: ['pool-a'] })).toEqual([
      'c-1',
      'c-2',
    ])
  })

  test('is empty when the exported session is not a pool session', () => {
    expect(childrenOutsideExport(tally, { scope: { session: 'c-1' }, sessionIds: ['c-1'] })).toEqual([])
  })

  test('leaves out a child that is in the export', () => {
    expect(
      childrenOutsideExport(tally, { scope: { session: 'pool-a' }, sessionIds: ['c-1', 'pool-a'] }),
    ).toEqual(['c-2'])
  })
})
