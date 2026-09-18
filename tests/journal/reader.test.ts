import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'
import { listSessions, readSession, readSessionWithStats } from '../../src/journal/reader.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { MAX_PAGE_LIMIT, searchSession } from '../../src/journal/search.js'
import { createJournalSink } from '../../src/journal/sink.js'
import type { SqliteHandle } from '../../src/store/sqlite.js'

/**
 * The reader after the M4.5 wave-5 cutover: `journal.db` is the only carrier
 * it reads. Sessions are written through the REAL sink, so a divergence
 * between what the writer stores and what the reader shows fails here rather
 * than in production; the legacy `*.jsonl` cases moved out with the file arm.
 */

let tempDir: string

function record(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: '2026-08-04T10:00:00.000Z',
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
  const sink = createJournalSink(sessionId, { dir: tempDir })
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
): Promise<void> {
  const lines = records
    .map((entry) => `${JSON.stringify({ ...entry, sessionId })}\n`)
    .join('')
  await writeFile(join(tempDir, `${sessionId}.jsonl`), lines, 'utf8')
}

async function openHandle(): Promise<SqliteHandle> {
  return openJournalDbShared(journalDbPathFor(tempDir))
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

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-reader-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('listSessions', () => {
  test('returns an empty list for an empty directory', async () => {
    const sessions = await listSessions(tempDir)

    expect(sessions).toEqual([])
  })

  test('returns an empty list for a missing directory instead of throwing', async () => {
    const missingDir = join(tempDir, 'does-not-exist')

    const sessions = await listSessions(missingDir)

    expect(sessions).toEqual([])
  })

  test('summarizes a session with sessionId, firstTs, lastTs and messageCount', async () => {
    await writeDbSession('session-a', [
      record({ ts: '2026-08-04T10:00:00.000Z' }),
      record({ ts: '2026-08-04T10:05:00.000Z' }),
      record({ ts: '2026-08-04T10:10:00.000Z' }),
    ])

    const sessions = await listSessions(tempDir)

    expect(sessions).toEqual([
      {
        sessionId: 'session-a',
        firstTs: '2026-08-04T10:00:00.000Z',
        lastTs: '2026-08-04T10:10:00.000Z',
        messageCount: 3,
        skippedLineCount: 0,
      },
    ])
  })

  test('sorts sessions newest-first by lastTs', async () => {
    await writeDbSession('session-old', [record({ ts: '2026-08-01T00:00:00.000Z' })])
    await writeDbSession('session-new', [record({ ts: '2026-08-04T00:00:00.000Z' })])

    const sessions = await listSessions(tempDir)

    expect(sessions.map((s) => s.sessionId)).toEqual(['session-new', 'session-old'])
  })

  /**
   * The cutover, stated as a behavior: an un-imported `*.jsonl` is not a
   * carrier any more. It stays on disk as a cold backup and becomes visible
   * again only through `mcpcut migrate`.
   */
  test('does not list an un-imported legacy *.jsonl session', async () => {
    await writeDbSession('imported', [record({ ts: '2026-08-04T00:00:00.000Z' })])
    await writeLegacySession('legacy', [record({ ts: '2026-08-05T00:00:00.000Z' })])

    const sessions = await listSessions(tempDir)

    expect(sessions.map((s) => s.sessionId)).toEqual(['imported'])
  })

  test('lists nothing at all when every session is an un-imported legacy file', async () => {
    await writeLegacySession('legacy-only', [record()])

    const sessions = await listSessions(tempDir)

    expect(sessions).toEqual([])
  })
})

describe('readSession', () => {
  test('returns all records for a session in write order', async () => {
    await writeDbSession('session-d', [
      record({ method: 'tools/list' }),
      record({ method: 'tools/call' }),
    ])

    const records = await readSession('session-d', { dir: tempDir })

    expect(records.map((r) => r.method)).toEqual(['tools/list', 'tools/call'])
  })

  test('filters by method', async () => {
    await writeDbSession('session-e', [
      record({ method: 'tools/list' }),
      record({ method: 'tools/call' }),
      record({ method: 'tools/list' }),
    ])

    const records = await readSession('session-e', { dir: tempDir, method: 'tools/list' })

    expect(records).toHaveLength(2)
    expect(records.every((r) => r.method === 'tools/list')).toBe(true)
  })

  test('filters by direction', async () => {
    await writeDbSession('session-f', [
      record({ direction: 'client→server' }),
      record({ direction: 'server→client' }),
      record({ direction: 'server-stderr', kind: 'stderr', payload: 'log line' }),
    ])

    const records = await readSession('session-f', { dir: tempDir, direction: 'server→client' })

    expect(records).toHaveLength(1)
    expect(records[0]?.direction).toBe('server→client')
  })

  test('filters by both method and direction together', async () => {
    await writeDbSession('session-g', [
      record({ method: 'tools/call', direction: 'client→server' }),
      record({ method: 'tools/call', direction: 'server→client' }),
      record({ method: 'tools/list', direction: 'client→server' }),
    ])

    const records = await readSession('session-g', {
      dir: tempDir,
      method: 'tools/call',
      direction: 'client→server',
    })

    expect(records).toHaveLength(1)
    expect(records[0]?.method).toBe('tools/call')
    expect(records[0]?.direction).toBe('client→server')
  })

  test('returns an empty array when the session is not in the database', async () => {
    const records = await readSession('missing-session', { dir: tempDir })

    expect(records).toEqual([])
  })

  test('returns an empty array when the directory does not exist', async () => {
    const records = await readSession('any-session', { dir: join(tempDir, 'nope') })

    expect(records).toEqual([])
  })

  test('returns an empty array for an un-imported legacy session', async () => {
    await writeLegacySession('legacy-read', [record(), record()])

    const records = await readSession('legacy-read', { dir: tempDir })

    expect(records).toEqual([])
  })

  test('filters by kind', async () => {
    await writeDbSession('session-i', [
      record({ kind: 'request' }),
      record({
        kind: 'decision',
        method: undefined,
        rpcId: undefined,
        payload: null,
        decision: {
          outcome: 'deny',
          rule: 'servers.github.tools.delete_*',
          serverName: 'github',
          toolName: 'delete_repo',
          toolClass: 'destructive',
          quarantineState: 'known',
          argsHash: 'sha256:abc',
        },
      }),
    ])

    const records = await readSession('session-i', { dir: tempDir, kind: 'decision' })

    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe('decision')
  })
})

describe('readSessionWithStats over the database arm', () => {
  test('returns every record of a session, past any page limit', async () => {
    const many = Array.from({ length: MAX_PAGE_LIMIT + 1 }, (_, index) =>
      record({ rpcId: index }),
    )
    await writeDbSession('uncapped', many)

    const { records } = await readSessionWithStats('uncapped', { dir: tempDir })

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
      dir: tempDir,
      method: 'tools/call',
    })
    const byDirection = await readSessionWithStats('filtered', {
      dir: tempDir,
      direction: 'server→client',
    })
    const byKind = await readSessionWithStats('filtered', { dir: tempDir, kind: 'notification' })

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
      dir: tempDir,
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
   * come back. It is then omitted from listings for the same reason a session
   * with no record is omitted — there is nothing to list — which is why
   * `readSession` (empty) and `listSessions` (absent) disagree in shape but
   * not in meaning.
   */
  test('reads as empty and is left out of the listings', async () => {
    await writeLegacySession('ghost', [record(), record()])
    await writeDbSession('alive', [record({ ts: '2026-08-10T00:00:00.000Z' })])
    const handle = await openHandle()
    markImported(handle, 'ghost')

    const records = await readSession('ghost', { dir: tempDir })
    const page = await searchSession('ghost', { dir: tempDir })
    const sessions = await listSessions(tempDir)

    expect(records).toEqual([])
    expect(page.records).toEqual([])
    expect(sessions.map((entry) => entry.sessionId)).toEqual(['alive'])
  })
})

describe('decision records (backward compatibility)', () => {
  test('reads a decision-kind record with a valid decision field', async () => {
    await writeDbSession('session-decision', [
      record({
        kind: 'decision',
        method: undefined,
        rpcId: undefined,
        payload: null,
        decision: {
          outcome: 'allow',
          rule: 'classDefaults.read',
          serverName: 'github',
          toolName: 'list_issues',
          toolClass: 'read',
          quarantineState: 'known',
          argsHash: 'sha256:xyz',
        },
      }),
    ])

    const records = await readSession('session-decision', { dir: tempDir })

    expect(records).toHaveLength(1)
    expect(records[0]?.decision?.outcome).toBe('allow')
  })

  test('still reads an old M1-style record with no decision field at all', async () => {
    await writeDbSession('session-old', [record({ kind: 'request', method: 'tools/list' })])

    const records = await readSession('session-old', { dir: tempDir })

    expect(records).toHaveLength(1)
    expect(records[0]?.decision).toBeUndefined()
  })
})
