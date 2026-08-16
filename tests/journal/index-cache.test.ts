import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createSessionIndexCache,
  DEFAULT_MAX_CACHED_SESSIONS,
  type SessionIndexCacheDeps,
} from '../../src/journal/index-cache.js'
import { openJournalDbIfPresent } from '../../src/journal/db.js'
import { dbSessionLastSeqFor, dbSessionSummaryFor } from '../../src/journal/db-read-session.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createJournalSink } from '../../src/journal/sink.js'

/**
 * `createSessionIndexCache` after the M4.5 wave-5 rewrite: freshness is
 * `MAX(seq)` per session (`dbSessionLastSeqs`/`dbSessionLastSeqFor`), the DB
 * analogue of the file arm's size+mtime pair this cache used before the
 * cutover. What matters behaviorally is unchanged — a call with nothing
 * written since re-summarizes nothing, one session's write refreshes only
 * that session — only the freshness token and its source moved from the
 * filesystem to `journal.db`.
 */

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-index-cache-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
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

/** Writes a session into `journal.db` through the real sink. */
async function writeSession(sessionId: string, records: readonly JournalRecord[]): Promise<void> {
  const sink = createJournalSink(sessionId, { dir: tempDir })
  for (const entry of records) {
    sink.write({ ...entry, sessionId })
  }
  await sink.close()
}

interface Counters {
  readonly summaryCalls: string[]
}

/** Wraps the real per-session summary query with a call-counting spy. */
function countingDeps(): { deps: Partial<SessionIndexCacheDeps>; counters: Counters } {
  const summaryCalls: string[] = []
  const deps: Partial<SessionIndexCacheDeps> = {
    summaryFor: (handle, sessionId) => {
      summaryCalls.push(sessionId)
      return dbSessionSummaryFor(handle, sessionId)
    },
  }
  return { deps, counters: { summaryCalls } }
}

describe('createSessionIndexCache: listSessions', () => {
  test('summarizes every session with counts, timestamps and doc-length stand-ins', async () => {
    await writeSession('cache-a', [
      record({ ts: '2026-08-11T10:00:00.000Z' }),
      record({ ts: '2026-08-11T10:05:00.000Z' }),
    ])
    const cache = createSessionIndexCache()

    const sessions = await cache.listSessions(tempDir)

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      sessionId: 'cache-a',
      firstTs: '2026-08-11T10:00:00.000Z',
      lastTs: '2026-08-11T10:05:00.000Z',
      count: 2,
      skippedLineCount: 0,
    })
  })

  test('returns sessions newest write first, agreeing with lastTs order', async () => {
    await writeSession('older', [record({ ts: '2026-08-01T00:00:00.000Z' })])
    await writeSession('newer', [record({ ts: '2026-08-10T00:00:00.000Z' })])
    const cache = createSessionIndexCache()

    const sessions = await cache.listSessions(tempDir)

    expect(sessions.map((entry) => entry.sessionId)).toEqual(['newer', 'older'])
  })

  test('returns an empty list for a directory with no database instead of throwing', async () => {
    const cache = createSessionIndexCache()

    await expect(cache.listSessions(join(tempDir, 'nope'))).resolves.toEqual([])
  })

  test('does not re-summarize a session that has not written since the last call', async () => {
    await writeSession('stable', [record(), record()])
    const { deps, counters } = countingDeps()
    const cache = createSessionIndexCache(deps)

    const first = await cache.listSessions(tempDir)
    const callsAfterFirst = counters.summaryCalls.length
    const second = await cache.listSessions(tempDir)

    expect(callsAfterFirst).toBeGreaterThan(0)
    expect(counters.summaryCalls).toHaveLength(callsAfterFirst)
    expect(second).toEqual(first)
  })

  test('a write to one session re-summarizes only that session', async () => {
    await writeSession('session-a', [record()])
    await writeSession('session-b', [record()])
    const { deps, counters } = countingDeps()
    const cache = createSessionIndexCache(deps)
    await cache.listSessions(tempDir)
    counters.summaryCalls.length = 0

    await writeSession('session-a', [record({ rpcId: 2 })])
    const sessions = await cache.listSessions(tempDir)

    expect(counters.summaryCalls).toEqual(['session-a'])
    expect(sessions.find((entry) => entry.sessionId === 'session-a')?.count).toBe(2)
    expect(sessions.find((entry) => entry.sessionId === 'session-b')?.count).toBe(1)
  })

  test('evicts the least recently used entry when the cache is full', async () => {
    for (const index of [0, 1, 2]) {
      await writeSession(`evict-${index}`, [record()])
    }
    const cache = createSessionIndexCache({}, { maxEntries: 2 })

    await cache.listSessions(tempDir)

    expect(cache.cachedCount()).toBeLessThanOrEqual(2)
  })

  test('clear() drops every cached summary, forcing a full re-summarize', async () => {
    await writeSession('cleared', [record()])
    const { deps, counters } = countingDeps()
    const cache = createSessionIndexCache(deps)
    await cache.listSessions(tempDir)
    const callsAfterFirst = counters.summaryCalls.length

    cache.clear()
    await cache.listSessions(tempDir)

    expect(cache.cachedCount()).toBe(1)
    expect(counters.summaryCalls).toHaveLength(callsAfterFirst * 2)
  })

  test('invalidate() forces a re-summarize of one session only', async () => {
    await writeSession('inv-a', [record()])
    await writeSession('inv-b', [record()])
    const { deps, counters } = countingDeps()
    const cache = createSessionIndexCache(deps)
    await cache.listSessions(tempDir)
    counters.summaryCalls.length = 0

    cache.invalidate('inv-a', tempDir)
    await cache.listSessions(tempDir)

    expect(counters.summaryCalls).toEqual(['inv-a'])
  })
})

describe('createSessionIndexCache: getSession', () => {
  test('returns one summary and null for a missing session', async () => {
    await writeSession('one', [record()])
    const cache = createSessionIndexCache()

    await expect(cache.getSession('one', tempDir)).resolves.toMatchObject({ count: 1 })
    await expect(cache.getSession('absent', tempDir)).resolves.toBeNull()
  })

  test('rejects an unsafe session id', async () => {
    const cache = createSessionIndexCache()

    await expect(cache.getSession('../escape', tempDir)).rejects.toThrow(/Invalid session id/)
  })

  test('returns null for a directory with no database instead of throwing', async () => {
    const cache = createSessionIndexCache()

    await expect(cache.getSession('any', join(tempDir, 'nope'))).resolves.toBeNull()
  })

  test('shares its cache entry with listSessions for the same session', async () => {
    await writeSession('shared', [record()])
    const { deps, counters } = countingDeps()
    const cache = createSessionIndexCache(deps)
    await cache.listSessions(tempDir)
    const callsAfterList = counters.summaryCalls.length

    await cache.getSession('shared', tempDir)

    expect(counters.summaryCalls).toHaveLength(callsAfterList)
  })

  test('re-summarizes once the session has a higher lastSeq than the cached entry', async () => {
    await writeSession('grows', [record()])
    const { deps, counters } = countingDeps()
    const cache = createSessionIndexCache(deps)
    await cache.getSession('grows', tempDir)

    await writeSession('grows', [record({ rpcId: 2 })])
    const summary = await cache.getSession('grows', tempDir)

    expect(counters.summaryCalls).toEqual(['grows', 'grows'])
    expect(summary?.count).toBe(2)
  })
})

describe('createSessionIndexCache: default export surface', () => {
  test('DEFAULT_MAX_CACHED_SESSIONS is a positive integer', () => {
    expect(DEFAULT_MAX_CACHED_SESSIONS).toBeGreaterThan(0)
  })
})

describe('dbSessionLastSeqFor (the cache\'s per-session freshness probe)', () => {
  test('is null for a session with no rows', async () => {
    await writeSession('present', [record()])
    const handle = await openJournalDbIfPresent(tempDir)

    expect(handle).not.toBeNull()
    expect(dbSessionLastSeqFor(handle as NonNullable<typeof handle>, 'absent')).toBeNull()
  })
})
