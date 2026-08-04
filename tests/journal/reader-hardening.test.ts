import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { listSessions, readSession, readSessionWithStats } from '../../src/journal/reader.js'
import type { JournalRecord } from '../../src/journal/record.js'

/**
 * Hardening regressions for the reader: JSONL lines are untrusted input
 * (the file may have been hand-edited or partially written), so every line
 * must be validated as a record before it is handed to callers, and the
 * session id must never be able to escape the journal directory.
 */

let tempDir: string

function record(overrides: Partial<JournalRecord> = {}): string {
  return JSON.stringify({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: '2026-08-04T10:00:00.000Z',
    sessionId: 'session-1',
    direction: 'client→server',
    kind: 'request',
    method: 'tools/call',
    rpcId: 1,
    payload: {},
    ...overrides,
  })
}

async function writeJsonl(fileName: string, lines: string[]): Promise<void> {
  await writeFile(join(tempDir, fileName), lines.join('\n') + '\n', 'utf8')
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-reader-hardening-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('record validation', () => {
  const nonRecordLines = [
    '{"foo":1}',
    '[1,2,3]',
    '"just a string"',
    'null',
    '42',
    '{"ts":123,"sessionId":"s","direction":"client→server","kind":"request","id":"x","payload":{}}',
    '{"ts":"2026-08-04T10:00:00.000Z","sessionId":"s","direction":"sideways","kind":"request","id":"x","payload":{}}',
    '{"ts":"2026-08-04T10:00:00.000Z","sessionId":"s","direction":"client→server","kind":"telepathy","id":"x","payload":{}}',
  ]

  test.each(nonRecordLines)('readSession skips the non-record line %s', async (line) => {
    await writeJsonl('session-x.jsonl', [record(), line, record()])

    const records = await readSession('session-x', { dir: tempDir })

    expect(records).toHaveLength(2)
  })

  test('listSessions does not crash on files whose lines are JSON but not records', async () => {
    await writeJsonl('session-y.jsonl', nonRecordLines)

    const sessions = await listSessions(tempDir)

    expect(sessions).toEqual([])
  })

  test('listSessions summarizes only the valid records in a mixed file', async () => {
    await writeJsonl('session-z.jsonl', [
      record({ ts: '2026-08-04T10:00:00.000Z' }),
      '{"foo":1}',
      'not json at all {{',
      record({ ts: '2026-08-04T10:09:00.000Z' }),
    ])

    const sessions = await listSessions(tempDir)

    expect(sessions[0]?.messageCount).toBe(2)
    expect(sessions[0]?.skippedLineCount).toBe(2)
  })

  test('accepts a stderr record shape', async () => {
    await writeJsonl('session-s.jsonl', [
      record({ direction: 'server-stderr', kind: 'stderr', payload: 'log line', method: undefined }),
    ])

    const records = await readSession('session-s', { dir: tempDir })

    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe('stderr')
  })
})

describe('readSessionWithStats', () => {
  test('reports how many lines were skipped alongside the records', async () => {
    await writeJsonl('session-w.jsonl', [record(), 'garbage', '{"foo":1}', record()])

    const result = await readSessionWithStats('session-w', { dir: tempDir })

    expect(result.records).toHaveLength(2)
    expect(result.skippedLineCount).toBe(2)
  })

  test('reports zero skipped lines for a clean file', async () => {
    await writeJsonl('session-clean.jsonl', [record(), record()])

    const result = await readSessionWithStats('session-clean', { dir: tempDir })

    expect(result.skippedLineCount).toBe(0)
  })

  test('filters apply to the returned records', async () => {
    await writeJsonl('session-filter.jsonl', [
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
