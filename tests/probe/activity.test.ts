import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'
import type { DecisionInfo, JournalRecord } from '../../src/journal/record.js'
import { createJournalSink } from '../../src/journal/sink.js'
import {
  createActivityTracker,
  DEFAULT_ACTIVITY_FRESH_AFTER_MS,
  type ActivityTrackerOptions,
} from '../../src/probe/activity.js'
import type { SqliteHandle } from '../../src/store/sqlite.js'

/**
 * The passive "last successful activity" signal (M5.5 p.1, Task 3): the
 * journal's newest decision records, scanned under a hard row ceiling and
 * cached in memory, answer "when did this server last serve an ALLOWED call?"
 * without a probe. Fixtures go through the REAL sink (the db-read.test.ts
 * pattern), so the scanner is tested against rows the writer actually
 * produces; only the malformed-row case hand-INSERTs.
 */

/** The tests' wall clock: everything is measured relative to this instant. */
const NOW_MS = Date.parse('2026-08-24T12:00:00.000Z')

const MINUTE_MS = 60_000

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-probe-activity-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

/** ISO timestamp `minutes` before the tests' NOW. */
function tsMinutesAgo(minutes: number): string {
  return new Date(NOW_MS - minutes * MINUTE_MS).toISOString()
}

function decision(overrides: Partial<DecisionInfo> = {}): DecisionInfo {
  return {
    outcome: 'allow',
    rule: 'classDefaults.read',
    serverName: 'github',
    toolName: 'list_issues',
    toolClass: 'read',
    quarantineState: 'known',
    argsHash: 'sha256:abc',
    ...overrides,
  }
}

function decisionRecord(
  decisionOverrides: Partial<DecisionInfo>,
  overrides: Partial<JournalRecord> = {},
): JournalRecord {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: tsMinutesAgo(5),
    sessionId: 'session-1',
    direction: 'client→server',
    kind: 'decision',
    payload: null,
    decision: decision(decisionOverrides),
    ...overrides,
  }
}

function trafficRecord(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: tsMinutesAgo(5),
    sessionId: 'session-1',
    direction: 'client→server',
    kind: 'request',
    method: 'tools/call',
    rpcId: 1,
    payload: {},
    ...overrides,
  }
}

/** Writes records through the real sink and waits for the commit. */
async function writeSession(sessionId: string, records: readonly JournalRecord[]): Promise<void> {
  const stamped = records.map((entry) => ({ ...entry, sessionId }))
  const sink = createJournalSink(sessionId, { dir: journalDir })
  for (const entry of stamped) {
    sink.write(entry)
  }
  await sink.close()
}

/** Hand-writes a row the sink could never produce: the untrusted-content case. */
async function insertRawDoc(sessionId: string, kind: string, doc: string): Promise<void> {
  const handle: SqliteHandle = await openJournalDbShared(journalDbPathFor(journalDir))
  handle.transaction((db) => {
    db.prepare(
      'INSERT INTO journal_records (session_id, record_id, ts, direction, kind, method, doc) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(sessionId, 'raw-row', tsMinutesAgo(1), 'client→server', kind, null, doc)
    return undefined
  })
}

function tracker(overrides: Partial<ActivityTrackerOptions> = {}) {
  return createActivityTracker({ journalDir, now: () => NOW_MS, ...overrides })
}

describe('lastSuccessfulActivity', () => {
  test('reports fresh activity for an allowed decision five minutes old', async () => {
    await writeSession('s1', [decisionRecord({ outcome: 'allow' }, { ts: tsMinutesAgo(5) })])

    const activity = await tracker().lastSuccessfulActivity('github')

    expect(activity).toEqual({ lastActivityAt: tsMinutesAgo(5), fresh: true })
  })

  test('activity older than the default one-hour threshold is not fresh', async () => {
    await writeSession('s1', [decisionRecord({ outcome: 'allow' }, { ts: tsMinutesAgo(120) })])

    const activity = await tracker().lastSuccessfulActivity('github')

    expect(activity).toEqual({ lastActivityAt: tsMinutesAgo(120), fresh: false })
  })

  test('the freshness threshold is injectable', async () => {
    await writeSession('s1', [decisionRecord({ outcome: 'allow' }, { ts: tsMinutesAgo(5) })])

    const activity = await tracker({ freshAfterMs: MINUTE_MS }).lastSuccessfulActivity('github')

    expect(activity).toEqual({ lastActivityAt: tsMinutesAgo(5), fresh: false })
  })

  test('the default threshold constant is one hour', () => {
    expect(DEFAULT_ACTIVITY_FRESH_AFTER_MS).toBe(60 * MINUTE_MS)
  })

  test('denied decisions alone are not successful activity', async () => {
    await writeSession('s1', [
      decisionRecord({ outcome: 'deny' }),
      decisionRecord({ outcome: 'denied-by-operator' }),
      decisionRecord({ outcome: 'timeout' }),
    ])

    expect(await tracker().lastSuccessfulActivity('github')).toBeNull()
  })

  test('an operator-approved call counts as successful activity', async () => {
    await writeSession('s1', [decisionRecord({ outcome: 'approved' }, { ts: tsMinutesAgo(3) })])

    const activity = await tracker().lastSuccessfulActivity('github')

    expect(activity).toEqual({ lastActivityAt: tsMinutesAgo(3), fresh: true })
  })

  test("another server's allowed decision does not count", async () => {
    await writeSession('s1', [decisionRecord({ serverName: 'other', outcome: 'allow' })])

    expect(await tracker().lastSuccessfulActivity('github')).toBeNull()
  })

  test('a server with only non-decision traffic records yields null', async () => {
    await writeSession('s1', [trafficRecord(), trafficRecord({ rpcId: 2 })])

    expect(await tracker().lastSuccessfulActivity('github')).toBeNull()
  })

  test('a journal directory without journal.db yields null, not an exception', async () => {
    expect(await tracker().lastSuccessfulActivity('github')).toBeNull()
  })

  test('an empty journal.db yields null, not an exception', async () => {
    await openJournalDbShared(journalDbPathFor(journalDir))

    expect(await tracker().lastSuccessfulActivity('github')).toBeNull()
  })

  test('the newest successful decision wins and the scan stops there', async () => {
    const onRowsScanned = vi.fn()
    await writeSession('s1', [decisionRecord({ outcome: 'allow' }, { ts: tsMinutesAgo(120) })])
    await writeSession('s2', [decisionRecord({ outcome: 'allow' }, { ts: tsMinutesAgo(5) })])

    const activity = await tracker({ onRowsScanned }).lastSuccessfulActivity('github')

    expect(activity).toEqual({ lastActivityAt: tsMinutesAgo(5), fresh: true })
    // Rows are walked newest-first, so the very first row is the answer.
    expect(onRowsScanned).toHaveBeenCalledWith(1)
  })

  test('a malformed newest row is skipped, not fatal', async () => {
    await writeSession('s1', [decisionRecord({ outcome: 'allow' }, { ts: tsMinutesAgo(5) })])
    await insertRawDoc('s1', 'decision', '{not json')

    const activity = await tracker().lastSuccessfulActivity('github')

    expect(activity).toEqual({ lastActivityAt: tsMinutesAgo(5), fresh: true })
  })

  test('the scan is bounded by maxScannedRows', async () => {
    const onRowsScanned = vi.fn()
    // The only match sits UNDER 30 newer filler rows, beyond a 10-row ceiling.
    await writeSession('s1', [decisionRecord({ outcome: 'allow' })])
    await writeSession('s2', wallOfTraffic(30))

    const activity = await tracker({ maxScannedRows: 10, onRowsScanned }).lastSuccessfulActivity(
      'github',
    )

    expect(activity).toBeNull()
    expect(onRowsScanned).toHaveBeenCalledWith(10)
  })

  test('a cached answer is served without rereading the database', async () => {
    const onRowsScanned = vi.fn()
    await writeSession('s1', [decisionRecord({ outcome: 'allow' }, { ts: tsMinutesAgo(5) })])
    const cached = tracker({ onRowsScanned, cacheTtlMs: 10 * MINUTE_MS })

    const first = await cached.lastSuccessfulActivity('github')
    const second = await cached.lastSuccessfulActivity('github')

    expect(second).toEqual(first)
    expect(onRowsScanned).toHaveBeenCalledTimes(1)
  })

  test('a null answer is cached too', async () => {
    const onRowsScanned = vi.fn()
    await writeSession('s1', [trafficRecord()])
    const cached = tracker({ onRowsScanned, cacheTtlMs: 10 * MINUTE_MS })

    expect(await cached.lastSuccessfulActivity('ghost')).toBeNull()
    expect(await cached.lastSuccessfulActivity('ghost')).toBeNull()
    expect(onRowsScanned).toHaveBeenCalledTimes(1)
  })

  test('the cache expires after its TTL and the database is reread', async () => {
    const onRowsScanned = vi.fn()
    let nowMs = NOW_MS
    await writeSession('s1', [decisionRecord({ outcome: 'allow' }, { ts: tsMinutesAgo(5) })])
    const expiring = tracker({ onRowsScanned, cacheTtlMs: 1000, now: () => nowMs })

    await expiring.lastSuccessfulActivity('github')
    nowMs += 1500
    await expiring.lastSuccessfulActivity('github')

    expect(onRowsScanned).toHaveBeenCalledTimes(2)
  })

  test('freshness is recomputed at read time, even on a cache hit', async () => {
    const onRowsScanned = vi.fn()
    let nowMs = NOW_MS
    await writeSession('s1', [decisionRecord({ outcome: 'allow' }, { ts: tsMinutesAgo(5) })])
    const cached = tracker({
      onRowsScanned,
      cacheTtlMs: 60 * MINUTE_MS,
      freshAfterMs: 10 * MINUTE_MS,
      now: () => nowMs,
    })

    const first = await cached.lastSuccessfulActivity('github')
    nowMs += 30 * MINUTE_MS
    const second = await cached.lastSuccessfulActivity('github')

    expect(first?.fresh).toBe(true)
    expect(second).toEqual({ lastActivityAt: tsMinutesAgo(5), fresh: false })
    expect(onRowsScanned).toHaveBeenCalledTimes(1)
  })

  test('caches are per server name', async () => {
    const onRowsScanned = vi.fn()
    await writeSession('s1', [
      decisionRecord({ serverName: 'github', outcome: 'allow' }),
      decisionRecord({ serverName: 'jira', outcome: 'allow' }, { ts: tsMinutesAgo(7) }),
    ])
    const shared = tracker({ onRowsScanned, cacheTtlMs: 10 * MINUTE_MS })

    const github = await shared.lastSuccessfulActivity('github')
    const jira = await shared.lastSuccessfulActivity('jira')

    expect(github?.lastActivityAt).toBe(tsMinutesAgo(5))
    expect(jira?.lastActivityAt).toBe(tsMinutesAgo(7))
    expect(onRowsScanned).toHaveBeenCalledTimes(2)
  })
})

/** `count` uncorrelated request records — journal noise between decisions. */
function wallOfTraffic(count: number): readonly JournalRecord[] {
  return Array.from({ length: count }, (_, index) => trafficRecord({ rpcId: index + 100 }))
}
