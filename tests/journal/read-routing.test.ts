import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { JOURNAL_DB_FILE_NAME, journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'
import { createSessionIndexCache } from '../../src/journal/index-cache.js'
import { listSessions, readSession, readSessionWithStats } from '../../src/journal/reader.js'
import type { JournalRecord } from '../../src/journal/record.js'
import {
  defaultJournalReadDeps,
  searchAllSessions,
  searchSession,
  MAX_PAGE_LIMIT,
} from '../../src/journal/search.js'
import { createJournalSink } from '../../src/journal/sink.js'
import type { SqliteHandle } from '../../src/store/sqlite.js'

/**
 * Routing between the journal's two read carriers (M4.5 wave 4, task 6): the
 * decisions `search.ts`, `reader.ts` and `index-cache.ts` make about WHICH arm
 * answers, as opposed to what each arm answers (that is `db-read.test.ts` and
 * `search.test.ts`). Everything here goes through the public entry points with
 * their unchanged signatures, because "the CLI and UI callers needed no edits"
 * is the property being tested.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-routing-test-'))
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

/** Writes a session into `journal.db` through the real sink. */
async function writeDbSession(
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

/** Writes a session the old way: a `*.jsonl` file nobody has imported yet. */
async function writeLegacySession(
  sessionId: string,
  records: readonly JournalRecord[],
): Promise<readonly JournalRecord[]> {
  const stamped = records.map((entry) => ({ ...entry, sessionId }))
  const lines = stamped.map((entry) => `${JSON.stringify(entry)}\n`).join('')
  await writeFile(join(journalDir, `${sessionId}.jsonl`), lines, 'utf8')
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

describe('merged session listings', () => {
  test('reader.listSessions shows both carriers, newest activity first', async () => {
    await writeDbSession('routed-db', [
      record({ ts: '2026-08-10T00:00:00.000Z' }),
      record({ ts: '2026-08-10T00:01:00.000Z' }),
    ])
    await writeLegacySession('routed-file', [
      record({ ts: '2026-08-05T00:00:00.000Z' }),
      record({ ts: '2026-08-05T00:01:00.000Z' }),
      record({ ts: '2026-08-05T00:02:00.000Z' }),
    ])

    const sessions = await listSessions(journalDir)

    expect(sessions.map((entry) => entry.sessionId)).toEqual(['routed-db', 'routed-file'])
    expect(sessions.map((entry) => entry.messageCount)).toEqual([2, 3])
    expect(sessions[0]?.firstTs).toBe('2026-08-10T00:00:00.000Z')
    expect(sessions[1]?.lastTs).toBe('2026-08-05T00:02:00.000Z')
  })

  test('the index cache shows both carriers, with sizes for each', async () => {
    await writeDbSession('cached-db', [record({ ts: '2026-08-10T00:00:00.000Z' })])
    await writeLegacySession('cached-file', [record({ ts: '2026-08-05T00:00:00.000Z' })])
    const cache = createSessionIndexCache()

    const sessions = await cache.listSessions(journalDir)

    expect(sessions.map((entry) => entry.sessionId)).toEqual(['cached-db', 'cached-file'])
    expect(sessions.map((entry) => entry.count)).toEqual([1, 1])
    expect(sessions[0]?.size).toBeGreaterThan(0)
    expect(sessions[0]?.mtimeMs).toBe(Date.parse('2026-08-10T00:00:00.000Z'))
    // Only the file arm's entry is cached: the database's summaries are one
    // indexed aggregate, and caching them would buy staleness for nothing.
    expect(cache.cachedCount()).toBe(1)
  })

  test('the index cache answers getSession for a database session', async () => {
    await writeDbSession('cached-one', [
      record({ ts: '2026-08-10T00:00:00.000Z' }),
      record({ ts: '2026-08-10T00:00:01.000Z' }),
    ])
    const cache = createSessionIndexCache()

    const summary = await cache.getSession('cached-one', journalDir)

    expect(summary?.count).toBe(2)
    expect(summary?.firstTs).toBe('2026-08-10T00:00:00.000Z')
    expect(summary?.lastTs).toBe('2026-08-10T00:00:01.000Z')
    expect(cache.cachedCount()).toBe(0)
  })
})

describe('a session in both carriers', () => {
  /**
   * Per-run ULIDs make this collision impossible in practice; the rule is
   * documented rather than defended, and this is where it is pinned down.
   */
  test('is served from the database, and the stale file is invisible', async () => {
    await writeDbSession('twice', [record({ method: 'from/db' })])
    await writeLegacySession('twice', [
      record({ method: 'from/file' }),
      record({ method: 'from/file' }),
    ])

    const records = await readSession('twice', { dir: journalDir })
    const page = await searchSession('twice', { dir: journalDir })
    const sessions = await listSessions(journalDir)

    expect(records.map((entry) => entry.method)).toEqual(['from/db'])
    expect(page.records.map((entry) => entry.method)).toEqual(['from/db'])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.messageCount).toBe(1)
  })
})

describe('a directory with no journal.db', () => {
  test('is never given one by a read', async () => {
    await writeLegacySession('legacy-only', [record()])
    const cache = createSessionIndexCache()

    await searchSession('legacy-only', { dir: journalDir })
    await searchAllSessions({ dir: journalDir })
    await readSession('legacy-only', { dir: journalDir })
    await listSessions(journalDir)
    await cache.listSessions(journalDir)
    await cache.getSession('legacy-only', journalDir)

    // An empty database would answer "I am the carrier" for every future
    // routing check and silence the whole legacy journal.
    const entries = await readdir(journalDir)
    expect(entries).toEqual(['legacy-only.jsonl'])
    expect(entries.some((name) => name.startsWith(JOURNAL_DB_FILE_NAME))).toBe(false)
  })

  test('still routes through the injectable file seam when deps are supplied', async () => {
    await writeLegacySession('injected', [record({ method: 'from/file' })])
    let readCalls = 0
    const deps = {
      readLines: (filePath: string) => {
        readCalls += 1
        return defaultJournalReadDeps.readLines(filePath)
      },
    }

    const page = await searchSession('injected', { dir: journalDir }, deps)

    expect(readCalls).toBe(1)
    expect(page.records.map((entry) => entry.method)).toEqual(['from/file'])
  })
})

describe('cross-session search over both carriers', () => {
  test('finds an un-imported legacy session after the database sessions', async () => {
    await writeDbSession('walk-db', [
      record({ ts: '2026-08-10T00:00:00.000Z', method: 'db/hit' }),
    ])
    await writeLegacySession('walk-file', [
      record({ ts: '2026-08-05T00:00:00.000Z', method: 'file/hit' }),
    ])

    const result = await searchAllSessions({ dir: journalDir })

    expect(result.hits.map((hit) => hit.sessionId)).toEqual(['walk-db', 'walk-file'])
    expect(result.hits.map((hit) => hit.record.method)).toEqual(['db/hit', 'file/hit'])
    // One session per carrier: the total counts what could have been opened.
    expect(result.filesTotal).toBe(2)
    expect(result.filesScanned).toBe(2)
    expect(result.truncated).toBe(false)
    expect(result.stoppedBy).toBeNull()
  })

  test('does not walk the file of a session the database already answered for', async () => {
    await writeDbSession('shadowed', [record({ method: 'from/db' })])
    await writeLegacySession('shadowed', [record({ method: 'from/file' })])

    const result = await searchAllSessions({ dir: journalDir })

    expect(result.hits.map((hit) => hit.record.method)).toEqual(['from/db'])
    expect(result.filesTotal).toBe(1)
  })

  test('spends one shared budget across the two arms', async () => {
    await writeDbSession('budget-db', [
      record({ ts: '2026-08-10T00:00:00.000Z' }),
      record({ ts: '2026-08-10T00:00:01.000Z' }),
    ])
    await writeLegacySession('budget-file', [
      record({ ts: '2026-08-05T00:00:00.000Z' }),
      record({ ts: '2026-08-05T00:00:01.000Z' }),
    ])

    const result = await searchAllSessions({ dir: journalDir, limit: 3 })

    // Two hits from the database, one from the file, and the fourth match is
    // what makes the truncation exact rather than a guess.
    expect(result.hits).toHaveLength(3)
    expect(result.hits.map((hit) => hit.sessionId)).toEqual([
      'budget-db',
      'budget-db',
      'budget-file',
    ])
    expect(result.truncated).toBe(true)
    expect(result.stoppedBy).toBe('limit')
  })
})

describe('readSessionWithStats over the database arm', () => {
  test('returns every record of a session, past any page limit', async () => {
    const many = Array.from({ length: MAX_PAGE_LIMIT + 1 }, (_, index) =>
      record({ rpcId: index }),
    )
    await writeDbSession('uncapped', many)

    const { records } = await readSessionWithStats('uncapped', { dir: journalDir })

    expect(records).toHaveLength(MAX_PAGE_LIMIT + 1)
    expect(records[MAX_PAGE_LIMIT]?.rpcId).toBe(MAX_PAGE_LIMIT)
  })

  test('honours the method, direction and kind filters', async () => {
    await writeDbSession('filtered', [
      record({ rpcId: 1, method: 'tools/call' }),
      record({ rpcId: 2, method: 'tools/list' }),
      record({ rpcId: 3, method: 'tools/call', direction: 'server→client', kind: 'response' }),
      record({ rpcId: 4, method: 'tools/call', kind: 'notification' }),
    ])

    const byMethod = await readSessionWithStats('filtered', {
      dir: journalDir,
      method: 'tools/call',
    })
    const byDirection = await readSessionWithStats('filtered', {
      dir: journalDir,
      direction: 'server→client',
    })
    const byKind = await readSessionWithStats('filtered', { dir: journalDir, kind: 'notification' })

    expect(byMethod.records.map((entry) => entry.rpcId)).toEqual([1, 3, 4])
    expect(byDirection.records.map((entry) => entry.rpcId)).toEqual([3])
    expect(byKind.records.map((entry) => entry.rpcId)).toEqual([4])
  })

  test('counts a malformed row as skipped instead of failing the read', async () => {
    await writeDbSession('malformed', [record({ rpcId: 1 }), record({ rpcId: 2 })])
    const handle = await openHandle()
    insertRawDoc(handle, 'malformed', '{"not":"a record"}')
    insertRawDoc(handle, 'malformed', 'not json at all')

    const { records, skippedLineCount } = await readSessionWithStats('malformed', {
      dir: journalDir,
    })

    expect(records.map((entry) => entry.rpcId)).toEqual([1, 2])
    expect(skippedLineCount).toBe(2)
  })
})

describe('a session with an import marker and no rows', () => {
  /**
   * The marker means the database is this session's carrier — after retention
   * prunes its rows, or after an import of a file whose every line was
   * garbage. The legacy file stays on disk as a cold backup and must NOT
   * resurrect the session: an operator who pruned it would otherwise see it
   * come back. It is then omitted from listings for the same reason a file
   * with no readable record is omitted — there is nothing to list — which is
   * why `readSession` (empty) and `listSessions` (absent) disagree in shape
   * but not in meaning.
   */
  test('reads as empty and is left out of the listings', async () => {
    await writeLegacySession('ghost', [record(), record()])
    await writeDbSession('alive', [record({ ts: '2026-08-10T00:00:00.000Z' })])
    const handle = await openHandle()
    markImported(handle, 'ghost')
    const cache = createSessionIndexCache()

    const records = await readSession('ghost', { dir: journalDir })
    const page = await searchSession('ghost', { dir: journalDir })
    const sessions = await listSessions(journalDir)
    const cached = await cache.listSessions(journalDir)

    expect(records).toEqual([])
    expect(page.records).toEqual([])
    expect(sessions.map((entry) => entry.sessionId)).toEqual(['alive'])
    expect(cached.map((entry) => entry.sessionId)).toEqual(['alive'])
    expect(await cache.getSession('ghost', journalDir)).toBeNull()
  })
})
