import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'
import { listSessions, readSession, readSessionWithStats } from '../../src/journal/reader.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createJournalSink } from '../../src/journal/sink.js'
import type { SqliteHandle } from '../../src/store/sqlite.js'

/**
 * Hardening regressions for the reader: a `doc` column is untrusted input (a
 * row may have been hand-written, imported from a hand-edited legacy file, or
 * left by another tool), so every row must be validated as a record before it
 * is handed to callers, and the session id must never be able to escape the
 * journal directory.
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
): Promise<void> {
  const sink = createJournalSink(sessionId, { dir: tempDir })
  for (const entry of records) {
    sink.write({ ...entry, sessionId })
  }
  await sink.close()
}

async function openHandle(): Promise<SqliteHandle> {
  return openJournalDbShared(journalDbPathFor(tempDir))
}

/** Hand-writes rows the sink could never produce: the untrusted-content case. */
function insertRawDocs(handle: SqliteHandle, sessionId: string, docs: readonly string[]): void {
  handle.transaction((db) => {
    const insert = db.prepare(
      'INSERT INTO journal_records (session_id, record_id, ts, direction, kind, method, doc) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    for (const doc of docs) {
      insert.run(sessionId, 'raw-row', '2026-08-04T10:00:00.000Z', 'client→server', 'request', null, doc)
    }
    return undefined
  })
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-reader-hardening-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('record validation', () => {
  const nonRecordDocs = [
    '{"foo":1}',
    '[1,2,3]',
    '"just a string"',
    'null',
    '42',
    '{"ts":123,"sessionId":"s","direction":"client→server","kind":"request","id":"x","payload":{}}',
    '{"ts":"2026-08-04T10:00:00.000Z","sessionId":"s","direction":"sideways","kind":"request","id":"x","payload":{}}',
    '{"ts":"2026-08-04T10:00:00.000Z","sessionId":"s","direction":"client→server","kind":"telepathy","id":"x","payload":{}}',
  ]

  test.each(nonRecordDocs)('readSession skips the non-record row %s', async (doc) => {
    await writeDbSession('session-x', [record(), record()])
    insertRawDocs(await openHandle(), 'session-x', [doc])

    const records = await readSession('session-x', { dir: tempDir })

    expect(records).toHaveLength(2)
  })

  /**
   * The listing is one indexed aggregate that never parses a `doc`, so a
   * session of nothing but garbage rows still counts as a session — unlike
   * the file arm, which had to read a file to learn it held no record.
   */
  test('listSessions does not crash on a session whose rows are JSON but not records', async () => {
    insertRawDocs(await openHandle(), 'session-y', nonRecordDocs)

    const sessions = await listSessions(tempDir)

    expect(sessions.map((entry) => entry.sessionId)).toEqual(['session-y'])
  })

  test.each([
    '{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","ts":"2026-08-04T10:00:00.000Z","sessionId":"s","direction":"client→server","kind":"decision","payload":null}',
    '{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","ts":"2026-08-04T10:00:00.000Z","sessionId":"s","direction":"client→server","kind":"decision","payload":null,"decision":{"rule":"x","toolName":"y"}}',
    '{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","ts":"2026-08-04T10:00:00.000Z","sessionId":"s","direction":"client→server","kind":"decision","payload":null,"decision":"not-an-object"}',
  ])('readSession skips a "decision" row with a missing or malformed decision field: %s', async (doc) => {
    await writeDbSession('session-decision-invalid', [record(), record()])
    insertRawDocs(await openHandle(), 'session-decision-invalid', [doc])

    const records = await readSession('session-decision-invalid', { dir: tempDir })

    expect(records).toHaveLength(2)
  })

  test('accepts a stderr record shape', async () => {
    await writeDbSession('session-s', [
      record({ direction: 'server-stderr', kind: 'stderr', payload: 'log line', method: undefined }),
    ])

    const records = await readSession('session-s', { dir: tempDir })

    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe('stderr')
  })
})

describe('readSessionWithStats', () => {
  test('reports how many rows were skipped alongside the records', async () => {
    await writeDbSession('session-w', [record(), record()])
    insertRawDocs(await openHandle(), 'session-w', ['garbage', '{"foo":1}'])

    const result = await readSessionWithStats('session-w', { dir: tempDir })

    expect(result.records).toHaveLength(2)
    expect(result.skippedLineCount).toBe(2)
  })

  test('reports zero skipped rows for a clean session', async () => {
    await writeDbSession('session-clean', [record(), record()])

    const result = await readSessionWithStats('session-clean', { dir: tempDir })

    expect(result.skippedLineCount).toBe(0)
  })

  test('filters apply to the returned records', async () => {
    await writeDbSession('session-filter', [
      record({ method: 'tools/list' }),
      record({ method: 'tools/call' }),
    ])

    const result = await readSessionWithStats('session-filter', {
      dir: tempDir,
      method: 'tools/list',
    })

    expect(result.records).toHaveLength(1)
  })
})

describe('streaming a large session', () => {
  test('reads every record of a session with many rows without loading it whole', async () => {
    const rowCount = 5_000
    const records = Array.from({ length: rowCount }, (_, index) =>
      record({ ts: `2026-08-04T10:00:${String(index % 60).padStart(2, '0')}.000Z`, rpcId: index }),
    )
    await writeDbSession('session-huge', records)

    const result = await readSessionWithStats('session-huge', { dir: tempDir })

    expect(result.records).toHaveLength(rowCount)
    expect(result.skippedLineCount).toBe(0)
  })
})

describe('session id validation', () => {
  test.each(['../escape', 'a/b', '..', 'sess ion', '', 'sess/../../etc/passwd', 'a\\b'])(
    'rejects the traversal-unsafe session id %j',
    async (sessionId) => {
      await expect(readSession(sessionId, { dir: tempDir })).rejects.toThrow(/session id/i)
    },
  )

  test('the rejection message does not echo raw control characters', async () => {
    await expect(readSession('bad\nid', { dir: tempDir })).rejects.toThrow(/session id/i)
  })

  test.each(['01ARZ3NDEKTSV4RRFFQ69G5FAV', 'session-1', 'test_session_2'])(
    'accepts the safe session id %s',
    async (sessionId) => {
      await expect(readSession(sessionId, { dir: tempDir })).resolves.toEqual([])
    },
  )
})
