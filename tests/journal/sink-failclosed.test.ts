import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createJournalSink } from '../../src/journal/sink.js'
import type { CommitBatchImpl } from '../../src/journal/batch-writer.js'
import {
  insertRecordRows,
  journalDbPathFor,
  openJournalDbShared,
  type JournalRecordRow,
} from '../../src/journal/db.js'
import type { JournalRecord } from '../../src/journal/record.js'

/**
 * Fail-closed hook coverage for the journal sink: single retry on a failed
 * commit, drop accounting, the onWriteError hook, and flush(). Faults are
 * injected through `commitBatchImpl` — the batch-carrier's replacement for
 * the JSONL-era `appendFileImpl` seam. These tests own
 * tests/journal/sink-failclosed.test.ts exclusively; sink.test.ts and
 * sink-hardening.test.ts must keep passing with the same expectations.
 */

const RETRY_DELAY_MS = 1

let tempDir: string

function makeRecord(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: new Date(0).toISOString(),
    sessionId: 'session-1',
    direction: 'client→server',
    kind: 'notification',
    payload: { hello: 'world' },
    ...overrides,
  }
}

/** The commit the sink would have done on its own, for impls that fail only once. */
async function commitForReal(dir: string, rows: readonly JournalRecordRow[]): Promise<void> {
  const handle = await openJournalDbShared(journalDbPathFor(dir))
  handle.transaction((db) => insertRecordRows(db, rows))
}

/** The records a session left in `journal.db`, in commit order. */
async function readRecords(dir: string): Promise<JournalRecord[]> {
  const handle = await openJournalDbShared(journalDbPathFor(dir))
  const rows = handle.db
    .prepare('SELECT doc FROM journal_records ORDER BY seq')
    .all() as { doc: string }[]
  return rows.map((row) => JSON.parse(row.doc) as JournalRecord)
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-sink-failclosed-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(tempDir, { recursive: true, force: true })
})

describe('fail-closed retry behavior', () => {
  test('retries once after a transient failure and the record survives', async () => {
    let calls = 0
    const commitBatchImpl: CommitBatchImpl = async (rows) => {
      calls += 1
      if (calls === 1) {
        throw new Error('transient EAGAIN')
      }
      return commitForReal(tempDir, rows)
    }
    const onWriteError = vi.fn()

    const sink = createJournalSink('session-1', {
      dir: tempDir,
      retryDelayMs: RETRY_DELAY_MS,
      onWriteError,
      commitBatchImpl,
    })

    sink.write(makeRecord({ payload: { seq: 0 } }))
    await sink.close()

    expect(calls).toBe(2)
    expect(onWriteError).not.toHaveBeenCalled()
    expect(sink.droppedRecordCount()).toBe(0)
    expect(await readRecords(tempDir)).toHaveLength(1)
  })

  test('permanent failure calls onWriteError exactly once per record with a growing dropped count', async () => {
    const commitBatchImpl: CommitBatchImpl = async () => {
      throw new Error('permanent ENOSPC')
    }
    const onWriteError = vi.fn()

    const sink = createJournalSink('session-1', {
      dir: tempDir,
      retryDelayMs: RETRY_DELAY_MS,
      onWriteError,
      commitBatchImpl,
    })

    sink.write(makeRecord({ payload: { seq: 0 } }))
    sink.write(makeRecord({ payload: { seq: 1 } }))
    await sink.close()

    expect(onWriteError).toHaveBeenCalledTimes(2)
    expect(onWriteError).toHaveBeenNthCalledWith(1, expect.anything(), 1)
    expect(onWriteError).toHaveBeenNthCalledWith(2, expect.anything(), 2)
    expect(sink.droppedRecordCount()).toBe(2)
  })

  test('onWriteError throwing is swallowed and does not break subsequent writes', async () => {
    let calls = 0
    const commitBatchImpl: CommitBatchImpl = async (rows) => {
      calls += 1
      if (calls <= 2) {
        // first batch: both the initial attempt and the retry fail
        throw new Error('permanent failure')
      }
      return commitForReal(tempDir, rows)
    }
    const onWriteError = vi.fn(() => {
      throw new Error('callback blew up')
    })

    const sink = createJournalSink('session-1', {
      dir: tempDir,
      retryDelayMs: RETRY_DELAY_MS,
      onWriteError,
      commitBatchImpl,
    })

    // Flushed apart so the two records travel in separate batches: a batch is
    // dropped whole, so "the next record still lands" needs a next batch.
    sink.write(makeRecord({ payload: { seq: 0 } }))
    await sink.flush()
    sink.write(makeRecord({ payload: { seq: 1 } }))
    await expect(sink.close()).resolves.toBeUndefined()

    expect(onWriteError).toHaveBeenCalledTimes(1)
    expect(sink.droppedRecordCount()).toBe(1)
    const records = await readRecords(tempDir)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ payload: { seq: 1 } })
  })
})

describe('droppedRecordCount()', () => {
  test('is zero when nothing has failed', async () => {
    const sink = createJournalSink('session-1', { dir: tempDir })

    sink.write(makeRecord())
    await sink.close()

    expect(sink.droppedRecordCount()).toBe(0)
  })

  test('accumulates across multiple permanently failed records', async () => {
    const commitBatchImpl: CommitBatchImpl = async () => {
      throw new Error('permanent failure')
    }

    const sink = createJournalSink('session-1', {
      dir: tempDir,
      retryDelayMs: RETRY_DELAY_MS,
      commitBatchImpl,
    })

    expect(sink.droppedRecordCount()).toBe(0)
    sink.write(makeRecord())
    await sink.flush()
    expect(sink.droppedRecordCount()).toBe(1)

    sink.write(makeRecord())
    sink.write(makeRecord())
    await sink.close()
    expect(sink.droppedRecordCount()).toBe(3)
  })
})

describe('flush()', () => {
  test('resolves after queued writes and the sink stays usable afterward', async () => {
    const sink = createJournalSink('session-1', { dir: tempDir })

    sink.write(makeRecord({ payload: { seq: 0 } }))
    await sink.flush()

    expect(await readRecords(tempDir)).toHaveLength(1)

    sink.write(makeRecord({ payload: { seq: 1 } }))
    await sink.close()

    expect(await readRecords(tempDir)).toHaveLength(2)
  })

  test('does not close the sink', async () => {
    const sink = createJournalSink('session-1', { dir: tempDir })

    sink.write(makeRecord())
    await sink.flush()
    sink.write(makeRecord())
    await sink.close()

    expect(await readRecords(tempDir)).toHaveLength(2)
  })
})

describe('default behavior with no new options', () => {
  test('an unwritable directory still just logs to stderr, never throws, and drops the record', async () => {
    const blockerFile = join(tempDir, 'blocked')
    await writeFile(blockerFile, 'i am a file, not a directory')
    const brokenDir = join(blockerFile, 'subdir')
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const sink = createJournalSink('session-1', { dir: brokenDir })

    expect(() => sink.write(makeRecord())).not.toThrow()
    await expect(sink.close()).resolves.toBeUndefined()

    expect(stderrSpy).toHaveBeenCalled()
    expect(sink.droppedRecordCount()).toBe(1)
  })
})
