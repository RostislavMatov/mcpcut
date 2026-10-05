import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { journalBounds } from '../../src/journal/db-read-after.js'
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
