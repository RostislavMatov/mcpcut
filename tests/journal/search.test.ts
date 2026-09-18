import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { DEFAULT_PAGE_LIMIT, searchAllSessions, searchSession } from '../../src/journal/search.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createJournalSink } from '../../src/journal/sink.js'

/**
 * The search front door after the M4.5 wave-5 cutover: `searchSession` and
 * `searchAllSessions` resolve the journal directory's `journal.db` and hand
 * over to `db-read.ts`, which is where the paging, filter and ceiling
 * expectations now live (`tests/journal/db-read.test.ts`). What is asserted
 * here is what the front door itself owns: routing to the database, the shape
 * a directory with no database answers with, and input screening.
 *
 * `createSessionIndexCache` moved to its own suite,
 * `tests/journal/index-cache.test.ts`, when it was rewritten on `lastSeq`
 * freshness (wave 5, task 5).
 */

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-search-test-'))
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

async function writeLines(sessionId: string, lines: readonly string[]): Promise<void> {
  await writeFile(join(tempDir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8')
}

async function writeRecords(
  sessionId: string,
  records: readonly JournalRecord[],
): Promise<void> {
  await writeLines(
    sessionId,
    records.map((entry) => JSON.stringify(entry)),
  )
}

describe('searchSession — the database front door', () => {
  test('returns the requested page of a database session in write order', async () => {
    await writeDbSession(
      'paged',
      Array.from({ length: 30 }, (_, index) => record({ rpcId: index })),
    )

    const page = await searchSession('paged', { dir: tempDir, offset: 10, limit: 5 })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([10, 11, 12, 13, 14])
    expect(page.offset).toBe(10)
    expect(page.limit).toBe(5)
    expect(page.hasMore).toBe(true)
  })

  test('applies the filters of a database session', async () => {
    await writeDbSession('filters', [
      record({ rpcId: 0, method: 'tools/list' }),
      record({ rpcId: 1, method: 'tools/call' }),
      record({ rpcId: 2, method: 'tools/call', direction: 'server→client', kind: 'response' }),
    ])

    const page = await searchSession('filters', { dir: tempDir, method: 'tools/call' })

    expect(page.records.map((entry) => entry.rpcId)).toEqual([1, 2])
  })

  test('returns an empty page when the session is not in the database', async () => {
    const page = await searchSession('missing', { dir: tempDir })

    expect(page.records).toEqual([])
    expect(page.skippedLineCount).toBe(0)
  })

  test('returns an empty page when the directory does not exist', async () => {
    const page = await searchSession('any', { dir: join(tempDir, 'nope') })

    expect(page.records).toEqual([])
    expect(page.hasMore).toBe(false)
  })

  /**
   * The cutover: a legacy `*.jsonl` is no longer a carrier. It stays on disk
   * as a cold backup and is readable again only after `mcpcut migrate`.
   */
  test('returns an empty page for an un-imported legacy session file', async () => {
    await writeRecords('legacy', [record({ rpcId: 1 }), record({ rpcId: 2 })])

    const page = await searchSession('legacy', { dir: tempDir })

    expect(page.records).toEqual([])
    expect(page.scannedLineCount).toBe(0)
  })

  test('throws before opening anything when the session id is unsafe', async () => {
    await expect(searchSession('../../etc/passwd', { dir: tempDir })).rejects.toThrow(
      /Invalid session id/,
    )
  })

  test('clamps a hostile page size instead of honouring it', async () => {
    await writeDbSession('clamp', [record()])

    const page = await searchSession('clamp', { dir: tempDir, limit: 10_000_000, offset: -5 })

    expect(page.limit).toBeLessThanOrEqual(1000)
    expect(page.offset).toBe(0)
  })

  test('falls back to the default page size when the numbers are not numbers', async () => {
    await writeDbSession('nan', [record()])

    const page = await searchSession('nan', { dir: tempDir, limit: Number.NaN, offset: Number.NaN })

    expect(page.limit).toBe(DEFAULT_PAGE_LIMIT)
    expect(page.offset).toBe(0)
    expect(page.records).toHaveLength(1)
  })

  /**
   * An empty page normalizes offset and limit exactly as a real one does, so
   * an operator's pagination controls read the same either way.
   */
  test('normalizes offset and limit on an empty page too', async () => {
    const page = await searchSession('absent', {
      dir: tempDir,
      limit: 10_000_000,
      offset: -5,
    })

    expect(page.limit).toBeLessThanOrEqual(1000)
    expect(page.offset).toBe(0)
    expect(page.truncated).toBe(false)
  })
})

describe('searchAllSessions', () => {
  test('walks database sessions newest-first and reports an untruncated scan', async () => {
    await writeDbSession('cross-old', [
      record({ ts: '2026-08-01T00:00:00.000Z', rpcId: 1, method: 'tools/call' }),
    ])
    await writeDbSession('cross-mid', [
      record({ ts: '2026-08-02T00:00:00.000Z', rpcId: 2, method: 'tools/call' }),
    ])
    await writeDbSession('cross-new', [
      record({ ts: '2026-08-03T00:00:00.000Z', rpcId: 3, method: 'tools/call' }),
    ])

    const result = await searchAllSessions({ dir: tempDir })

    expect(result.hits.map((hit) => hit.sessionId)).toEqual([
      'cross-new',
      'cross-mid',
      'cross-old',
    ])
    expect(result.hits.map((hit) => hit.record.rpcId)).toEqual([3, 2, 1])
    expect(result.truncated).toBe(false)
    expect(result.stoppedBy).toBeNull()
    expect(result.filesScanned).toBe(3)
    expect(result.filesTotal).toBe(3)
  })

  test('returns an empty result for a missing directory instead of throwing', async () => {
    const result = await searchAllSessions({ dir: join(tempDir, 'nope') })

    expect(result.hits).toEqual([])
    expect(result.truncated).toBe(false)
    expect(result.stoppedBy).toBeNull()
    expect(result.filesTotal).toBe(0)
    expect(result.filesScanned).toBe(0)
  })

  test('returns an empty result for a directory that holds only legacy files', async () => {
    await writeRecords('legacy-a', [record()])
    await writeRecords('legacy-b', [record()])

    const result = await searchAllSessions({ dir: tempDir })

    expect(result.hits).toEqual([])
    expect(result.filesTotal).toBe(0)
  })

  /**
   * A path that is not a directory used to surface as ENOTDIR from the file
   * walk. The database probe classifies ENOTDIR as "no database here" (it is
   * the same `isMissing` the probe always used), so the honest answer is now
   * an empty journal rather than a thrown error.
   */
  test('answers empty for a journal path that is not a directory', async () => {
    await writeFile(join(tempDir, 'plain.txt'), 'not a directory', 'utf8')

    const result = await searchAllSessions({ dir: join(tempDir, 'plain.txt') })

    expect(result.hits).toEqual([])
    expect(result.filesTotal).toBe(0)
  })
})
