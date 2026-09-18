import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  getBatchWriter,
  type CommitBatchImpl,
  type JournalBatchWriter,
  type SettleResult,
} from '../../src/journal/batch-writer.js'
import {
  journalDbPathFor,
  openJournalDbShared,
  type JournalRecordRow,
} from '../../src/journal/db.js'

/**
 * The per-process batch writer (M4.5 wave 4): buffer → commit on size or
 * delay, promise-chained commits, batch-level retry-then-drop settlement.
 * Test structure mirrors `tests/journal/db.test.ts` (mkdtemp + afterEach rm);
 * every case passes options, which per the writer's cache rule yields a
 * dedicated instance — shared writers are for production callers only.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-batch-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

/** Long enough that a commit inside a test can only have come from the size trigger. */
const NEVER_MS = 60_000

/** Enough traffic from a second sink to drown a flush that waited for quiet. */
const OTHER_SINK_RECORDS = 20

function makeRow(recordId: string, overrides: Partial<JournalRecordRow> = {}): JournalRecordRow {
  return {
    sessionId: 'session-1',
    recordId,
    ts: new Date(0).toISOString(),
    direction: 'client→server',
    kind: 'notification',
    method: 'tools/call',
    doc: JSON.stringify({ id: recordId }),
    ...overrides,
  }
}

/** Enqueues `row` and resolves with its settlement, so a test can await one record. */
function enqueueSettled(writer: JournalBatchWriter, row: JournalRecordRow): Promise<SettleResult> {
  return new Promise<SettleResult>((resolve) => {
    writer.enqueue(row, resolve)
  })
}

async function selectRecordIds(dbPath: string): Promise<string[]> {
  const handle = await openJournalDbShared(dbPath)
  const rows = handle.db
    .prepare('SELECT record_id AS recordId FROM journal_records ORDER BY seq')
    .all() as { recordId: string }[]
  return rows.map((row) => row.recordId)
}

async function selectSeqs(dbPath: string): Promise<number[]> {
  const handle = await openJournalDbShared(dbPath)
  const rows = handle.db.prepare('SELECT seq FROM journal_records ORDER BY seq').all() as {
    seq: number
  }[]
  return rows.map((row) => row.seq)
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('commit triggers', () => {
  test('the batch commits on the size trigger without any flush call', async () => {
    const dbPath = journalDbPathFor(journalDir)
    const writer = getBatchWriter(dbPath, { maxRecords: 4, maxDelayMs: NEVER_MS })

    const settled = [
      enqueueSettled(writer, makeRow('rec-1')),
      enqueueSettled(writer, makeRow('rec-2')),
      enqueueSettled(writer, makeRow('rec-3')),
      enqueueSettled(writer, makeRow('rec-4')),
    ]

    const results = await Promise.all(settled)

    expect(results.every((result) => result.ok)).toBe(true)
    await expect(selectRecordIds(dbPath)).resolves.toEqual(['rec-1', 'rec-2', 'rec-3', 'rec-4'])
  })

  test('a lone record commits on the delay trigger without any flush call', async () => {
    const dbPath = journalDbPathFor(journalDir)
    const writer = getBatchWriter(dbPath, { maxRecords: 256, maxDelayMs: 5 })

    const result = await enqueueSettled(writer, makeRow('rec-lonely'))

    expect(result).toEqual({ ok: true })
    await expect(selectRecordIds(dbPath)).resolves.toEqual(['rec-lonely'])
  })

  test('flushNow commits immediately and resolves only once the rows are durable', async () => {
    const dbPath = journalDbPathFor(journalDir)
    const writer = getBatchWriter(dbPath, { maxRecords: 256, maxDelayMs: NEVER_MS })

    writer.enqueue(makeRow('rec-1'), () => {})
    writer.enqueue(makeRow('rec-2'), () => {})
    await writer.flushNow()

    // No timer could have fired (NEVER_MS) and the size trigger was not reached.
    await expect(selectRecordIds(dbPath)).resolves.toEqual(['rec-1', 'rec-2'])
  })

  test('flushNow with nothing buffered resolves and is safe to repeat', async () => {
    const dbPath = journalDbPathFor(journalDir)
    const writer = getBatchWriter(dbPath, { maxRecords: 256, maxDelayMs: NEVER_MS })

    await writer.flushNow()
    await writer.flushNow()

    await expect(selectRecordIds(dbPath)).resolves.toEqual([])
  })
})

describe('failure contract', () => {
  test('a failing commit is retried once, then every record in the batch is dropped once', async () => {
    let attempts = 0
    let isFailing = true
    const commitBatchImpl: CommitBatchImpl = async () => {
      attempts += 1
      if (isFailing) throw new Error('injected commit failure')
    }
    const writer = getBatchWriter(journalDbPathFor(journalDir), {
      maxRecords: 2,
      maxDelayMs: NEVER_MS,
      retryDelayMs: 1,
      commitBatchImpl,
    })

    const dropped = await Promise.all([
      enqueueSettled(writer, makeRow('rec-1')),
      enqueueSettled(writer, makeRow('rec-2')),
    ])

    expect(attempts).toBe(2) // initial + exactly one retry, for the whole batch
    expect(dropped.map((result) => result.ok)).toEqual([false, false])
    for (const result of dropped) {
      expect(result.ok ? undefined : result.error).toBeInstanceOf(Error)
    }

    // The queue survives a dropped batch: the next one still commits.
    isFailing = false
    const recovered = await Promise.all([
      enqueueSettled(writer, makeRow('rec-3')),
      enqueueSettled(writer, makeRow('rec-4')),
    ])
    expect(recovered).toEqual([{ ok: true }, { ok: true }])
    expect(attempts).toBe(3)
  })

  test('each record settles exactly once', async () => {
    const commitBatchImpl: CommitBatchImpl = async () => {
      throw new Error('injected commit failure')
    }
    const writer = getBatchWriter(journalDbPathFor(journalDir), {
      maxRecords: 2,
      maxDelayMs: NEVER_MS,
      retryDelayMs: 1,
      commitBatchImpl,
    })
    const settlements: SettleResult[] = []

    writer.enqueue(makeRow('rec-1'), (result) => settlements.push(result))
    writer.enqueue(makeRow('rec-2'), (result) => settlements.push(result))
    await writer.flushNow()

    expect(settlements).toHaveLength(2)
  })

  test('a commit that fails once and then succeeds settles its records as written', async () => {
    let attempts = 0
    const commitBatchImpl: CommitBatchImpl = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('transient failure')
    }
    const writer = getBatchWriter(journalDbPathFor(journalDir), {
      maxRecords: 2,
      maxDelayMs: NEVER_MS,
      retryDelayMs: 1,
      commitBatchImpl,
    })

    const results = await Promise.all([
      enqueueSettled(writer, makeRow('rec-1')),
      enqueueSettled(writer, makeRow('rec-2')),
    ])

    expect(attempts).toBe(2)
    expect(results).toEqual([{ ok: true }, { ok: true }])
  })

  test('an onSettled callback that throws never breaks later commits', async () => {
    const dbPath = journalDbPathFor(journalDir)
    const writer = getBatchWriter(dbPath, { maxRecords: 1, maxDelayMs: NEVER_MS })

    writer.enqueue(makeRow('rec-1'), () => {
      throw new Error('consumer callback exploded')
    })
    await writer.flushNow()
    const later = await enqueueSettled(writer, makeRow('rec-2'))

    expect(later).toEqual({ ok: true })
    await expect(selectRecordIds(dbPath)).resolves.toEqual(['rec-1', 'rec-2'])
  })
})

describe('serialization', () => {
  test('a commit never starts before the previous one has resolved', async () => {
    const events: string[] = []
    let inFlight = 0
    const commitBatchImpl: CommitBatchImpl = async (rows) => {
      inFlight += 1
      expect(inFlight).toBe(1) // overlap would make this 2
      events.push(`start:${rows[0]?.recordId ?? '?'}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      events.push(`end:${rows[0]?.recordId ?? '?'}`)
      inFlight -= 1
    }
    const writer = getBatchWriter(journalDbPathFor(journalDir), {
      maxRecords: 1,
      maxDelayMs: NEVER_MS,
      commitBatchImpl,
    })

    writer.enqueue(makeRow('rec-1'), () => {})
    writer.enqueue(makeRow('rec-2'), () => {})
    writer.enqueue(makeRow('rec-3'), () => {})
    await writer.flushNow()

    expect(events).toEqual([
      'start:rec-1',
      'end:rec-1',
      'start:rec-2',
      'end:rec-2',
      'start:rec-3',
      'end:rec-3',
    ])
  })

  test('flushNow during an in-flight commit waits for it and flushes what buffered meanwhile', async () => {
    const gate = deferred()
    const committed: string[] = []
    let isFirstCommit = true
    const commitBatchImpl: CommitBatchImpl = async (rows) => {
      const wasFirst = isFirstCommit
      isFirstCommit = false
      if (wasFirst) await gate.promise
      for (const row of rows) committed.push(row.recordId)
    }
    const writer = getBatchWriter(journalDbPathFor(journalDir), {
      maxRecords: 256,
      maxDelayMs: NEVER_MS,
      commitBatchImpl,
    })

    writer.enqueue(makeRow('rec-slow'), () => {})
    const firstFlush = writer.flushNow() // puts the gated commit in flight
    await Promise.resolve()
    // Neither trigger can pick this one up: only a flush can.
    writer.enqueue(makeRow('rec-meanwhile'), () => {})

    const flushing = writer.flushNow()
    let hasResolved = false
    void flushing.then(() => {
      hasResolved = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(hasResolved).toBe(false) // still blocked on the in-flight commit

    gate.release()
    await Promise.all([firstFlush, flushing])

    expect(committed).toEqual(['rec-slow', 'rec-meanwhile'])
  })

  test('a second sink enqueueing into the same writer cannot starve a flush', async () => {
    // Arrange: one gated commit, so the flush under test is still pending
    // while the other sink's traffic piles up behind it.
    const gate = deferred()
    const committed: string[] = []
    let isFirstCommit = true
    const commitBatchImpl: CommitBatchImpl = async (rows) => {
      const wasFirst = isFirstCommit
      isFirstCommit = false
      if (wasFirst) await gate.promise
      for (const row of rows) committed.push(row.recordId)
    }
    const writer = getBatchWriter(journalDbPathFor(journalDir), {
      maxRecords: 256,
      maxDelayMs: NEVER_MS,
      commitBatchImpl,
    })

    // Act: sink A flushes its one record, then sink B keeps arriving.
    writer.enqueue(makeRow('rec-a', { sessionId: 'session-a' }), () => {})
    const flushingA = writer.flushNow()
    let hasResolved = false
    void flushingA.then(() => {
      hasResolved = true
    })
    for (let index = 0; index < OTHER_SINK_RECORDS; index += 1) {
      writer.enqueue(makeRow(`rec-b-${index}`, { sessionId: 'session-b' }), () => {})
      await Promise.resolve()
    }
    expect(hasResolved).toBe(false) // still blocked on A's own commit, as it should be

    gate.release()
    await flushingA

    // Assert: A's flush covers A's record and stops there. B's records were
    // enqueued AFTER the call, so they are outside its contract — waiting for
    // them (and for whatever arrived while waiting) is the starvation this
    // guards against, and it is unbounded when the traffic never stops.
    expect(committed).toEqual(['rec-a'])

    // …and nothing was lost: they commit on the next flush.
    await writer.flushNow()
    expect(committed).toHaveLength(1 + OTHER_SINK_RECORDS)
  })
})

describe('two writers on one database (two processes in one)', () => {
  test('interleaved enqueues from two writers lose no rows and keep seq increasing', async () => {
    const dbPath = journalDbPathFor(journalDir)
    const left = getBatchWriter(dbPath, { maxRecords: 2, maxDelayMs: NEVER_MS })
    const right = getBatchWriter(dbPath, { maxRecords: 2, maxDelayMs: NEVER_MS })

    expect(right).not.toBe(left) // options ⇒ dedicated instances

    const settled: Promise<SettleResult>[] = []
    for (let index = 0; index < 6; index += 1) {
      settled.push(enqueueSettled(left, makeRow(`left-${index}`, { sessionId: 'session-left' })))
      settled.push(enqueueSettled(right, makeRow(`right-${index}`, { sessionId: 'session-right' })))
    }
    await Promise.all([left.flushNow(), right.flushNow()])
    const results = await Promise.all(settled)

    expect(results.every((result) => result.ok)).toBe(true)
    const recordIds = await selectRecordIds(dbPath)
    expect(recordIds).toHaveLength(12)
    expect(new Set(recordIds).size).toBe(12)

    const seqs = await selectSeqs(dbPath)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })
})

describe('writer sharing', () => {
  test('production callers (no options) share one writer per database path', () => {
    const dbPath = journalDbPathFor(journalDir)

    expect(getBatchWriter(dbPath)).toBe(getBatchWriter(dbPath))
  })

  test('a different database path gets a different shared writer', () => {
    expect(getBatchWriter(journalDbPathFor(journalDir))).not.toBe(
      getBatchWriter(journalDbPathFor(join(journalDir, 'nested'))),
    )
  })
})
