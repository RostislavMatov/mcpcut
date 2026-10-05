import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { journalBounds, journalRecordsAfter } from '../../src/journal/db-read-after.js'
import { createJournalSink } from '../../src/journal/sink.js'
import type { JournalRecord } from '../../src/journal/record.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-journal-bounds-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('journalBounds', () => {
  test('a directory without journal.db reads as empty and gets none', async () => {
    expect(await journalBounds(dir)).toEqual({ maxSeq: 0, prunedThroughSeq: 0 })
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(dir)).toEqual([])
  })

  test('the newest seq follows the records written', async () => {
    const sink = createJournalSink('s1', { dir })
    for (const id of ['01ARZ3NDEKTSV4RRFFQ69G0001', '01ARZ3NDEKTSV4RRFFQ69G0002']) {
      sink.write({ id, ts: '2026-10-05T10:00:00.000Z', sessionId: 's1', direction: 'client→server', kind: 'message', payload: {} } as unknown as JournalRecord)
    }
    await sink.close()
    expect(await journalBounds(dir)).toEqual({ maxSeq: 2, prunedThroughSeq: 0 })
  })
})

function rec(id: string, kind: string, sessionId = 's1'): JournalRecord {
  return { id, ts: '2026-10-05T10:00:00.000Z', sessionId, direction: 'client→server', kind, payload: {}, ...(kind === 'decision' ? { decision: { outcome: 'allow', rule: 'r', serverName: 'files', toolName: 'read_file', toolClass: 'read', quarantineState: 'known', argsHash: 'h' } } : {}) } as unknown as JournalRecord
}

describe('journalRecordsAfter', () => {
  async function seed(): Promise<void> {
    const sink = createJournalSink('s1', { dir })
    const kinds = ['message', 'decision', 'message', 'access-edit', 'decision']
    kinds.forEach((kind, index) => sink.write(rec(`01ARZ3NDEKTSV4RRFFQ69G000${index + 1}`, kind)))
    await sink.close()
  }

  test('a directory without journal.db reads as empty, keeps the cursor and gets none', async () => {
    expect(await journalRecordsAfter(dir, 7, 10)).toEqual({ rows: [], throughSeq: 7 })
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(dir)).toEqual([])
  })

  test('returns only decisions and edits after the cursor, oldest first, through the newest seq', async () => {
    await seed()
    const all = await journalRecordsAfter(dir, 0, 10)
    expect(all.rows.map((row) => [row.seq, row.record.kind, row.sessionId])).toEqual([
      [2, 'decision', 's1'],
      [4, 'access-edit', 's1'],
      [5, 'decision', 's1'],
    ])
    expect(all.throughSeq).toBe(5)
    expect((await journalRecordsAfter(dir, 4, 10)).rows.map((row) => row.seq)).toEqual([5])
  })

  test('a full batch resumes from its last row, not from the journal end', async () => {
    await seed()
    const first = await journalRecordsAfter(dir, 0, 2)
    expect(first.rows.map((row) => row.seq)).toEqual([2, 4])
    expect(first.throughSeq).toBe(4)
    const rest = await journalRecordsAfter(dir, first.throughSeq, 2)
    expect(rest.rows.map((row) => row.seq)).toEqual([5])
    expect(rest.throughSeq).toBe(5)
  })

  test('a cursor at the end changes nothing', async () => {
    await seed()
    expect(await journalRecordsAfter(dir, 5, 10)).toEqual({ rows: [], throughSeq: 5 })
  })
})
