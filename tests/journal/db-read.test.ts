import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'
import {
  dbHasSession,
  dbSearchAllSessions,
  dbSearchSession,
  dbSessionSummaries,
} from '../../src/journal/db-read.js'
import type { DecisionInfo, JournalRecord } from '../../src/journal/record.js'
import { createJournalSink } from '../../src/journal/sink.js'
import { DEFAULT_PAGE_LIMIT } from '../../src/journal/search.js'
import type { SqliteHandle } from '../../src/store/sqlite.js'

/**
 * Parity suite for the SQL read arm (M4.5 wave 4, task 5): the expectations of
 * `tests/journal/search.test.ts` restated against rows in `journal.db` instead
 * of lines in a `*.jsonl` file. Rows are written through the REAL sink, so a
 * divergence between what the writer stores and what the reader expects shows
 * up here rather than in production; only the malformed-row cases hand-INSERT,
 * because no sink can produce a `doc` its own reader rejects.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-db-read-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function record(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: '2026-08-11T10:00:00.000Z',
    sessionId: 'session-1',
    direction: 'client→server',
    kind: 'request',
    method: 'tools/call',
    rpcId: 1,
    payload: {},
    ...overrides,
  }
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
  decisionOverrides: Partial<DecisionInfo> = {},
  overrides: Partial<JournalRecord> = {},
): JournalRecord {
  return record({
    kind: 'decision',
    method: undefined,
    payload: null,
    decision: decision(decisionOverrides),
    ...overrides,
  })
}

/** Writes one session's records through the real sink and waits for the commit. */
async function writeSession(
  sessionId: string,
  records: readonly JournalRecord[],
): Promise<readonly JournalRecord[]> {
  const stamped = records.map((entry) => ({ ...entry, sessionId }))
  const sink = createJournalSink(sessionId, { dir: journalDir })
  for (const entry of stamped) {
    sink.write(entry)
  }
  await sink.close()
  return stamped
}

async function openHandle(): Promise<SqliteHandle> {
  return openJournalDbShared(journalDbPathFor(journalDir))
}

/** Hand-writes a row the sink could never produce: the untrusted-content case. */
function insertRawDoc(handle: SqliteHandle, sessionId: string, doc: string): void {
  handle.transaction((db) => {
    db.prepare(
      'INSERT INTO journal_records (session_id, record_id, ts, direction, kind, method, doc) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(sessionId, 'raw-row', '2026-08-11T10:00:00.000Z', 'client→server', 'request', null, doc)
    return undefined
  })
}

function markImported(handle: SqliteHandle, sessionId: string): void {
  handle.transaction((db) => {
    db.prepare('INSERT INTO imported_sessions (session_id) VALUES (?)').run(sessionId)
    return undefined
  })
}

/** A clock that jumps `stepMs` on every read: makes deadline trips deterministic. */
function steppingClock(stepMs: number): () => number {
  let currentMs = 0
  return () => {
    currentMs += stepMs
    return currentMs
  }
}

function docLengthOf(records: readonly JournalRecord[]): number {
  return records.reduce((total, entry) => total + JSON.stringify(entry).length, 0)
}

describe('dbSessionSummaries', () => {
  test('aggregates every session, newest last activity first', async () => {
    const older = await writeSession('sum-old', [
      record({ ts: '2026-08-01T00:00:00.000Z' }),
      record({ ts: '2026-08-01T00:05:00.000Z' }),
    ])
    const newer = await writeSession('sum-new', [
      record({ ts: '2026-08-10T00:00:00.000Z' }),
      record({ ts: '2026-08-10T00:01:00.000Z' }),
      record({ ts: '2026-08-10T00:02:00.000Z' }),
    ])
    const handle = await openHandle()

    const summaries = dbSessionSummaries(handle)

    expect(summaries.map((entry) => entry.sessionId)).toEqual(['sum-new', 'sum-old'])
    expect(summaries[0]).toEqual({
      sessionId: 'sum-new',
      firstTs: '2026-08-10T00:00:00.000Z',
      lastTs: '2026-08-10T00:02:00.000Z',
      count: 3,
      skippedLineCount: 0,
      size: docLengthOf(newer),
      mtimeMs: Date.parse('2026-08-10T00:02:00.000Z'),
    })
    expect(summaries[1]).toMatchObject({
      firstTs: '2026-08-01T00:00:00.000Z',
      lastTs: '2026-08-01T00:05:00.000Z',
      count: 2,
      size: docLengthOf(older),
    })
  })

  test('never parses doc: a malformed row still counts and skips nothing', async () => {
    await writeSession('sum-mixed', [record()])
    const handle = await openHandle()
    insertRawDoc(handle, 'sum-mixed', 'not json at all {{{')

    const summaries = dbSessionSummaries(handle)

    expect(summaries[0]?.count).toBe(2)
    expect(summaries[0]?.skippedLineCount).toBe(0)
  })
})

describe('dbHasSession', () => {
  test('is true for a session with rows', async () => {
    await writeSession('present', [record()])
    const handle = await openHandle()

    expect(dbHasSession(handle, 'present')).toBe(true)
  })

  test('is true for an imported session with no rows yet', async () => {
    const handle = await openHandle()
    markImported(handle, 'marker-only')

    expect(dbHasSession(handle, 'marker-only')).toBe(true)
  })

  test('is false for a session the database has never seen', async () => {
    await writeSession('other', [record()])
    const handle = await openHandle()

    expect(dbHasSession(handle, 'absent')).toBe(false)
  })
})

describe('dbSearchSession — paging', () => {
  async function writeTenRecords(): Promise<void> {
    await writeSession(
      'paged',
      Array.from({ length: 10 }, (_, index) => record({ rpcId: index })),
    )
  }

  test('returns the requested page in seq order with hasMore true', async () => {
    await writeTenRecords()
    const handle = await openHandle()

    const page = dbSearchSession(handle, 'paged', { offset: 3, limit: 4 })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([3, 4, 5, 6])
    expect(page.offset).toBe(3)
    expect(page.limit).toBe(4)
    expect(page.hasMore).toBe(true)
    expect(page.truncated).toBe(false)
  })

  test('reports hasMore false when the page ends exactly at the last record', async () => {
    await writeTenRecords()
    const handle = await openHandle()

    const page = dbSearchSession(handle, 'paged', { offset: 6, limit: 4 })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([6, 7, 8, 9])
    expect(page.hasMore).toBe(false)
  })

  test('returns an empty page when the offset is past the end', async () => {
    await writeTenRecords()
    const handle = await openHandle()

    const page = dbSearchSession(handle, 'paged', { offset: 50, limit: 10 })

    expect(page.records).toEqual([])
    expect(page.hasMore).toBe(false)
  })

  test('clamps a hostile page size and a negative offset', async () => {
    await writeTenRecords()
    const handle = await openHandle()

    const page = dbSearchSession(handle, 'paged', { limit: 10_000_000, offset: -5 })

    expect(page.limit).toBeLessThanOrEqual(1000)
    expect(page.offset).toBe(0)
  })

  test('falls back to the default page size when the numbers are not numbers', async () => {
    await writeTenRecords()
    const handle = await openHandle()

    const page = dbSearchSession(handle, 'paged', { limit: Number.NaN, offset: Number.NaN })

    expect(page.limit).toBe(DEFAULT_PAGE_LIMIT)
    expect(page.offset).toBe(0)
    expect(page.records).toHaveLength(10)
  })
})

describe('dbSearchSession — filters', () => {
  const mixed: readonly JournalRecord[] = [
    record({ rpcId: 0, method: 'tools/list', direction: 'client→server' }),
    record({ rpcId: 1, method: 'tools/call', direction: 'client→server' }),
    record({ rpcId: 2, method: 'tools/call', direction: 'server→client', kind: 'response' }),
    decisionRecord({ toolName: 'delete_repo', outcome: 'deny' }, { rpcId: 3 }),
    decisionRecord({ toolName: 'create_issue', outcome: 'approved' }, { rpcId: 4 }),
  ]

  async function writeMixed(): Promise<SqliteHandle> {
    await writeSession('filters', mixed)
    return openHandle()
  }

  test('filters by kind', async () => {
    const handle = await writeMixed()

    const page = dbSearchSession(handle, 'filters', { kind: 'decision' })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([3, 4])
  })

  test('filters by direction', async () => {
    const handle = await writeMixed()

    const page = dbSearchSession(handle, 'filters', { direction: 'server→client' })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([2])
  })

  test('filters by method', async () => {
    const handle = await writeMixed()

    const page = dbSearchSession(handle, 'filters', { method: 'tools/call' })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([1, 2])
  })

  test('filters by decision toolName', async () => {
    const handle = await writeMixed()

    const page = dbSearchSession(handle, 'filters', { toolName: 'delete_repo' })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([3])
  })

  test('filters by decision outcome', async () => {
    const handle = await writeMixed()

    const page = dbSearchSession(handle, 'filters', { outcome: 'approved' })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([4])
  })

  test('filters by case-insensitive substring across payload, method and decision', async () => {
    await writeSession('text', [
      record({ rpcId: 0, payload: { params: { name: 'list_issues' } } }),
      record({ rpcId: 1, payload: { params: { name: 'DELETE_repo' } } }),
      decisionRecord({ rule: 'servers.github.tools.delete_*' }, { rpcId: 2 }),
    ])
    const handle = await openHandle()

    const page = dbSearchSession(handle, 'text', { text: 'delete_' })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([1, 2])
  })

  test('combines every filter field at once', async () => {
    await writeSession('combined', [
      ...mixed,
      decisionRecord(
        { toolName: 'create_issue', outcome: 'approved', rule: 'servers.github.tools.create_*' },
        { rpcId: 99, direction: 'client→server', method: 'tools/call' },
      ),
    ])
    const handle = await openHandle()

    const page = dbSearchSession(handle, 'combined', {
      kind: 'decision',
      direction: 'client→server',
      method: 'tools/call',
      toolName: 'create_issue',
      outcome: 'approved',
      text: 'servers.github.tools.create_',
    })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([99])
  })
})

describe('dbSearchSession — ceilings and untrusted rows', () => {
  test('marks the page truncated when the scan cap is reached', async () => {
    await writeSession(
      'capped',
      Array.from({ length: 20 }, (_, index) => record({ rpcId: index })),
    )
    const handle = await openHandle()

    const page = dbSearchSession(handle, 'capped', { limit: 100, maxScannedLines: 5 })

    expect(page.truncated).toBe(true)
    expect(page.scannedLineCount).toBe(5)
    expect(page.records).toHaveLength(5)
  })

  test('skips malformed doc rows, counts them, and still returns the good ones', async () => {
    await writeSession('broken', [record({ rpcId: 0 })])
    const handle = await openHandle()
    insertRawDoc(handle, 'broken', 'not json at all {{{')
    insertRawDoc(handle, 'broken', JSON.stringify({ kind: 'request' }))
    await writeSession('broken', [record({ rpcId: 1 })])

    const page = dbSearchSession(handle, 'broken', {})

    expect(page.records.map((entry) => entry.rpcId)).toEqual([0, 1])
    expect(page.skippedLineCount).toBe(2)
    expect(page.scannedLineCount).toBe(4)
  })

  test('rejects a decision row whose decision field is the wrong shape', async () => {
    await writeSession('bad-decision', [record({ rpcId: 7 })])
    const handle = await openHandle()
    insertRawDoc(
      handle,
      'bad-decision',
      JSON.stringify(record({ kind: 'decision', decision: undefined })),
    )

    const page = dbSearchSession(handle, 'bad-decision', {})

    expect(page.records.map((entry) => entry.rpcId)).toEqual([7])
    expect(page.skippedLineCount).toBe(1)
  })

  test('returns an empty page for a session the database does not hold', async () => {
    await writeSession('kept', [record()])
    const handle = await openHandle()

    const page = dbSearchSession(handle, 'missing', {})

    expect(page.records).toEqual([])
    expect(page.scannedLineCount).toBe(0)
    expect(page.skippedLineCount).toBe(0)
  })
})

describe('dbSearchAllSessions', () => {
  async function writeThreeSessions(): Promise<void> {
    await writeSession('cross-old', [
      record({ rpcId: 1, method: 'tools/call', ts: '2026-08-01T00:00:00.000Z' }),
    ])
    await writeSession('cross-mid', [
      record({ rpcId: 2, method: 'tools/call', ts: '2026-08-05T00:00:00.000Z' }),
    ])
    await writeSession('cross-new', [
      record({ rpcId: 3, method: 'tools/call', ts: '2026-08-10T00:00:00.000Z' }),
    ])
  }

  test('walks sessions newest-first and reports an untruncated scan', async () => {
    await writeThreeSessions()
    const handle = await openHandle()

    const result = dbSearchAllSessions(handle, {}, Date.now)

    expect(result.hits.map((hit) => hit.sessionId)).toEqual([
      'cross-new',
      'cross-mid',
      'cross-old',
    ])
    expect(result.hits.map((hit) => hit.record.rpcId)).toEqual([3, 2, 1])
    expect(result.truncated).toBe(false)
    expect(result.stoppedBy).toBeNull()
    expect(result.filesScanned).toBe(3)
    expect(result.filesTotal).toBe(3)
    expect(result.bytesRead).toBeGreaterThan(0)
  })

  test('applies the same filters as a single-session search', async () => {
    await writeSession('f-1', [
      record({ rpcId: 1, method: 'tools/list' }),
      decisionRecord({ toolName: 'delete_repo', outcome: 'deny' }, { rpcId: 2 }),
    ])
    await writeSession('f-2', [
      decisionRecord({ toolName: 'delete_repo', outcome: 'deny' }, { rpcId: 3 }),
    ])
    const handle = await openHandle()

    const result = dbSearchAllSessions(
      handle,
      { kind: 'decision', toolName: 'delete_repo', outcome: 'deny' },
      Date.now,
    )

    expect(result.hits.map((hit) => hit.record.rpcId).sort()).toEqual([2, 3])
  })

  test('stops at the hit limit only when there is genuinely more to return', async () => {
    await writeThreeSessions()
    const handle = await openHandle()

    const capped = dbSearchAllSessions(handle, { limit: 2 }, Date.now)
    const exact = dbSearchAllSessions(handle, { limit: 3 }, Date.now)

    expect(capped.hits).toHaveLength(2)
    expect(capped.truncated).toBe(true)
    expect(capped.stoppedBy).toBe('limit')
    expect(exact.hits).toHaveLength(3)
    expect(exact.truncated).toBe(false)
    expect(exact.stoppedBy).toBeNull()
  })

  test('stops at the session limit and says so', async () => {
    await writeSession('one', [record({ rpcId: 1, ts: '2026-08-01T00:00:00.000Z' })])
    await writeSession('two', [record({ rpcId: 2, ts: '2026-08-10T00:00:00.000Z' })])
    const handle = await openHandle()

    const result = dbSearchAllSessions(handle, { maxFiles: 1 }, Date.now)

    expect(result.truncated).toBe(true)
    expect(result.stoppedBy).toBe('files')
    expect(result.filesScanned).toBe(1)
    expect(result.filesTotal).toBe(2)
    expect(result.hits.map((hit) => hit.sessionId)).toEqual(['two'])
  })

  test('stops at the byte limit and says so', async () => {
    await writeThreeSessions()
    const handle = await openHandle()

    const result = dbSearchAllSessions(handle, { maxBytes: 10 }, Date.now)

    expect(result.truncated).toBe(true)
    expect(result.stoppedBy).toBe('bytes')
    expect(result.filesScanned).toBeLessThan(result.filesTotal)
    expect(result.bytesRead).toBeGreaterThan(0)
  })

  test('stops at the deadline between sessions and says so', async () => {
    await writeThreeSessions()
    const handle = await openHandle()

    const result = dbSearchAllSessions(handle, { timeBudgetMs: 1000 }, steppingClock(600))

    expect(result.truncated).toBe(true)
    expect(result.stoppedBy).toBe('deadline')
    expect(result.filesScanned).toBeLessThan(result.filesTotal)
  })

  test('counts unreadable rows across sessions instead of failing', async () => {
    await writeSession('bad-1', [record({ rpcId: 1, ts: '2026-08-01T00:00:00.000Z' })])
    await writeSession('bad-2', [record({ rpcId: 2, ts: '2026-08-10T00:00:00.000Z' })])
    const handle = await openHandle()
    insertRawDoc(handle, 'bad-1', '{{{')
    insertRawDoc(handle, 'bad-2', 'still not json')

    const result = dbSearchAllSessions(handle, {}, Date.now)

    expect(result.hits).toHaveLength(2)
    expect(result.skippedLineCount).toBe(2)
  })
})

describe('an empty database', () => {
  test('yields no summaries, an empty page and an untruncated empty walk', async () => {
    const handle = await openHandle()

    const summaries = dbSessionSummaries(handle)
    const page = dbSearchSession(handle, 'nobody', {})
    const result = dbSearchAllSessions(handle, {}, Date.now)

    expect(summaries).toEqual([])
    expect(page.records).toEqual([])
    expect(page.hasMore).toBe(false)
    expect(page.truncated).toBe(false)
    expect(result).toEqual({
      hits: [],
      truncated: false,
      stoppedBy: null,
      filesScanned: 0,
      filesTotal: 0,
      bytesRead: 0,
      skippedLineCount: 0,
    })
  })
})
