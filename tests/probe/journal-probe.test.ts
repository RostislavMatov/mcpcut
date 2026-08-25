import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { PROBE_SESSION_ID } from '../../src/probe/constants.js'
import type { ProbeResult } from '../../src/probe/engine.js'
import { journalProbe } from '../../src/probe/journal-probe.js'

/**
 * `src/probe/journal-probe.ts` (M5.5 п.1, Task 5): one probe = one journal
 * record through the EXISTING sink under the reserved `plane_probe` session.
 * The stored status document is the operator-facing truth; the journal write
 * is evidence — so a dropped record (sqlite busy) must never fail the probe,
 * only be counted, mirroring the sink's own drop accounting.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-probe-journal-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(journalDir, { recursive: true, force: true })
})

const ALIVE: ProbeResult = {
  status: 'alive',
  initializeLatencyMs: 41.7,
  probedVia: 'initialize',
}

async function storedRecords(): Promise<readonly JournalRecord[]> {
  const handle = await openJournalDbShared(journalDbPathFor(journalDir))
  const rows = handle.db
    .prepare('SELECT session_id AS sessionId, kind, doc FROM journal_records ORDER BY seq')
    .all() as { sessionId: string; kind: string; doc: string }[]
  return rows.map((row) => JSON.parse(row.doc) as JournalRecord)
}

describe('journalProbe', () => {
  test('writes one probe record under the reserved session id', async () => {
    const outcome = await journalProbe({
      serverName: 'github-live',
      initiator: { trigger: 'registration', adminName: 'alice' },
      result: ALIVE,
      dir: journalDir,
    })

    expect(outcome).toEqual({ written: true, droppedCount: 0 })
    const records = await storedRecords()
    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record?.sessionId).toBe(PROBE_SESSION_ID)
    expect(record?.kind).toBe('probe')
    expect(record?.payload).toEqual({
      serverName: 'github-live',
      initiator: { trigger: 'registration', adminName: 'alice' },
      outcome: 'alive',
      probedVia: 'initialize',
      initializeLatencyMs: 42,
    })
  })

  test('a failed probe result lands with its outcome and error', async () => {
    const outcome = await journalProbe({
      serverName: 'github-live',
      initiator: { trigger: 'lazy' },
      result: { status: 'vault-refused', message: 'secret "gh-token" is not in the vault' },
      dir: journalDir,
    })

    expect(outcome.written).toBe(true)
    const records = await storedRecords()
    expect(records[0]?.payload).toEqual({
      serverName: 'github-live',
      initiator: { trigger: 'lazy' },
      outcome: 'vault-refused',
      error: 'secret "gh-token" is not in the vault',
    })
  })

  test('a dropped record does not fail the call and is counted', async () => {
    // Same fault-injection seam as tests/journal/sink-failclosed.test.ts:
    // every commit fails, so the batch (and its single record) is dropped
    // after the one retry.
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const outcome = await journalProbe({
      serverName: 'github-live',
      initiator: { trigger: 'refresh', adminName: 'bob' },
      result: ALIVE,
      dir: journalDir,
      sinkOptions: {
        retryDelayMs: 1,
        commitBatchImpl: () => Promise.reject(new Error('SQLITE_BUSY: database is locked')),
      },
    })

    expect(outcome).toEqual({ written: false, droppedCount: 1 })
  })

  test('never throws: an unexpected failure becomes a counted drop', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const outcome = await journalProbe({
      serverName: 'github-live',
      initiator: { trigger: 'lazy' },
      result: ALIVE,
      dir: journalDir,
      clock: () => {
        throw new Error('broken injected clock')
      },
    })

    expect(outcome).toEqual({ written: false, droppedCount: 1 })
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('failed to write a probe record'),
    )
  })
})
