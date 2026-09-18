import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { listUnimportedLegacySessions, migrateJournalFiles } from '../../src/journal/import.js'
import {
  insertRecordRows,
  journalDbPathFor,
  openJournalDbShared,
  type JournalRecordRow,
} from '../../src/journal/db.js'
import { GENESIS_PREV_HASH, linkHashOf } from '../../src/journal/chain.js'
import { readSession } from '../../src/journal/reader.js'
import { JOURNAL_BATCH_MAX_RECORDS } from '../../src/config.js'
import { readJournalChainRows } from '../support/journal-rows.js'

/**
 * `migrateJournalFiles` (M4.5 wave 4, Task 7; refusal behavior M5 task 3.4):
 * bulk import of legacy `*.jsonl` files into `journal.db`. Test structure
 * mirrors `tests/journal/db.test.ts` (mkdtemp + afterEach rm, direct SQL
 * assertions against the handle) plus behavioral assertions through the
 * public reader, which is what actually proves the reader (`reader.ts`,
 * DB-only since wave 5) serves an imported session from the database.
 *
 * M5 task 3.4 replaced the old wipe-and-reload idempotency mechanism (a
 * first-batch `DELETE FROM journal_records WHERE session_id = ?`) with a
 * refusal: a session with rows but no marker is left untouched and reported
 * in `refusedSessions`, because a chain is now folded across insertion order
 * (`chain.ts`/`db.ts`) and deleting rows from its middle breaks every link
 * after them. Every exact-equality assertion below therefore carries a
 * `refusedSessions` field the old result shape did not have; the tests that
 * exercised the DELETE directly are rewritten, not merely patched — see each
 * one's comment for why its OLD expectation no longer holds.
 */

/** Re-derives every session's chain from `linkHashOf` and confirms it matches what is
 * stored, catching a broken or forked link the way a later `verify` command would. */
async function assertChainIntact(journalDir: string): Promise<void> {
  const rows = await readJournalChainRows(journalDir)
  let prev = GENESIS_PREV_HASH
  for (const row of rows) {
    if (row.prevHash === null || row.recordHash === null) continue // pre-chain row: not attested
    expect(row.prevHash).toBe(prev)
    expect(row.recordHash).toBe(linkHashOf(row.prevHash, row.doc))
    prev = row.recordHash
  }
}

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-import-test-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(journalDir, { recursive: true, force: true })
})

function journalLine(sessionId: string, index: number): string {
  return JSON.stringify({
    id: `01AAAAAAAAAAAAAAAAAAAAAA${index}`,
    ts: new Date(index * 1000).toISOString(),
    sessionId,
    direction: 'client→server',
    kind: 'notification',
    payload: { index },
  })
}

async function writeLegacyFile(sessionId: string, recordCount: number): Promise<void> {
  const lines = Array.from({ length: recordCount }, (_, index) => journalLine(sessionId, index))
  await writeFile(join(journalDir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
}

async function markerPresent(sessionId: string): Promise<boolean> {
  const handle = await openJournalDbShared(journalDbPathFor(journalDir))
  const row = handle.db
    .prepare('SELECT 1 FROM imported_sessions WHERE session_id = ?')
    .get(sessionId)
  return row !== undefined
}

async function rowCountFor(sessionId: string): Promise<number> {
  const handle = await openJournalDbShared(journalDbPathFor(journalDir))
  const row = handle.db
    .prepare('SELECT COUNT(*) AS n FROM journal_records WHERE session_id = ?')
    .get(sessionId) as { n: number }
  return row.n
}

describe('migrateJournalFiles: no legacy files', () => {
  test('an empty directory reports "no-files"', async () => {
    await expect(migrateJournalFiles(journalDir)).resolves.toEqual({ status: 'no-files' })
  })

  test('a directory with no *.jsonl files (only other content) reports "no-files"', async () => {
    await writeFile(join(journalDir, 'agents.json'), '{}', 'utf8')
    await expect(migrateJournalFiles(journalDir)).resolves.toEqual({ status: 'no-files' })
  })
})

describe('migrateJournalFiles: importing legacy files', () => {
  test('two files (3 + 2 records) import fully, markers land, rows are readable through the public reader', async () => {
    await writeLegacyFile('session-a', 3)
    await writeLegacyFile('session-b', 2)

    const result = await migrateJournalFiles(journalDir)

    expect(result).toEqual({
      status: 'imported',
      recordCount: 5,
      sessionCount: 2,
      refusedSessions: [],
    })
    await expect(markerPresent('session-a')).resolves.toBe(true)
    await expect(markerPresent('session-b')).resolves.toBe(true)
    await assertChainIntact(journalDir)

    // Reading through the public reader (not raw SQL) proves the reader
    // actually serves these sessions from journal.db now.
    const sessionA = await readSession('session-a', { dir: journalDir })
    const sessionB = await readSession('session-b', { dir: journalDir })
    expect(sessionA).toHaveLength(3)
    expect(sessionB).toHaveLength(2)
    expect(sessionA.map((record) => record.payload)).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }])
  })

  test('malformed lines among valid ones are skipped; valid records are still imported', async () => {
    const lines = [journalLine('session-mixed', 0), 'not json at all', journalLine('session-mixed', 1)]
    await writeFile(join(journalDir, 'session-mixed.jsonl'), `${lines.join('\n')}\n`, 'utf8')

    const result = await migrateJournalFiles(journalDir)

    expect(result).toEqual({
      status: 'imported',
      recordCount: 2,
      sessionCount: 1,
      refusedSessions: [],
    })
    await expect(rowCountFor('session-mixed')).resolves.toBe(2)
  })

  test('a file whose every line is malformed still gets a marker, contributing 0 records', async () => {
    await writeFile(
      join(journalDir, 'session-garbage.jsonl'),
      'not json\nalso not json\n{"still": "wrong shape"}\n',
      'utf8',
    )

    const result = await migrateJournalFiles(journalDir)

    expect(result).toEqual({
      status: 'imported',
      recordCount: 0,
      sessionCount: 1,
      refusedSessions: [],
    })
    await expect(markerPresent('session-garbage')).resolves.toBe(true)
    await expect(rowCountFor('session-garbage')).resolves.toBe(0)
  })
})

describe('migrateJournalFiles: idempotence', () => {
  test('re-running after a full import reports "already-migrated" and does not duplicate rows', async () => {
    await writeLegacyFile('session-a', 3)
    await migrateJournalFiles(journalDir)

    const second = await migrateJournalFiles(journalDir)

    expect(second).toEqual({ status: 'already-migrated', refusedSessions: [] })
    await expect(rowCountFor('session-a')).resolves.toBe(3)
  })

  test('a killed-mid-file import (partial rows, no marker) is refused, not wiped, and the rows survive untouched', async () => {
    // OLD expectation (pre-M5-task-3.4): this scenario was "wiped and fully
    // reloaded on re-run" — the first batch's `DELETE FROM journal_records
    // WHERE session_id = ?` treated a marker-less session as always-safe to
    // discard and replace. That was correct only because rows carried no
    // relationship to each other. Wave 3's hash chain folds `prev_hash` across
    // EVERY row in insertion order (`db.ts`'s `insertRecordRows`), so deleting
    // rows from the middle of the chain — which is exactly what this DELETE
    // does when other sessions were interleaved by `seq` — breaks every link
    // after them, permanently. The DELETE is gone; this state is now refused.
    await writeLegacyFile('session-a', 5)
    // Simulate a process killed between the first batch's insert and the
    // file's final batch: partial rows exist, but no marker was ever
    // written, because the marker only lands with the last batch.
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    const partialRows: JournalRecordRow[] = [
      {
        sessionId: 'session-a',
        recordId: 'stale-1',
        ts: new Date(0).toISOString(),
        direction: 'client→server',
        kind: 'notification',
        method: null,
        doc: '{"stale":true}',
      },
      {
        sessionId: 'session-a',
        recordId: 'stale-2',
        ts: new Date(0).toISOString(),
        direction: 'client→server',
        kind: 'notification',
        method: null,
        doc: '{"stale":true}',
      },
    ]
    handle.transaction((db) => insertRecordRows(db, partialRows))
    await expect(rowCountFor('session-a')).resolves.toBe(2)
    await expect(markerPresent('session-a')).resolves.toBe(false)

    const result = await migrateJournalFiles(journalDir)

    expect(result).toEqual({
      status: 'already-migrated',
      refusedSessions: ['session-a'],
    })
    // The two partial rows are exactly what remains: neither deleted nor
    // added to. The file's other 3 records were never read.
    await expect(rowCountFor('session-a')).resolves.toBe(2)
    const rows = await readJournalChainRows(journalDir, 'session-a')
    expect(rows.map((row) => row.doc)).toEqual(['{"stale":true}', '{"stale":true}'])
    await assertChainIntact(journalDir)
  })
})

describe('migrateJournalFiles: mixed marker state', () => {
  test('one already-imported file plus one new file imports only the new one', async () => {
    await writeLegacyFile('session-old', 2)
    await migrateJournalFiles(journalDir)
    await writeLegacyFile('session-new', 4)

    const result = await migrateJournalFiles(journalDir)

    expect(result).toEqual({
      status: 'imported',
      recordCount: 4,
      sessionCount: 1,
      refusedSessions: [],
    })
    await expect(rowCountFor('session-old')).resolves.toBe(2)
    await expect(rowCountFor('session-new')).resolves.toBe(4)
  })

  test('a refused file (partial rows, no marker) does not stop an unaffected file in the same directory', async () => {
    await writeLegacyFile('session-partial', 5)
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    const partialRow: JournalRecordRow = {
      sessionId: 'session-partial',
      recordId: 'stale-1',
      ts: new Date(0).toISOString(),
      direction: 'client→server',
      kind: 'notification',
      method: null,
      doc: '{"stale":true}',
    }
    handle.transaction((db) => insertRecordRows(db, [partialRow]))
    await writeLegacyFile('session-fresh', 3)

    const result = await migrateJournalFiles(journalDir)

    expect(result).toEqual({
      status: 'imported',
      recordCount: 3,
      sessionCount: 1,
      refusedSessions: ['session-partial'],
    })
    // The refused session's one stale row is untouched; the fresh file
    // imported in full despite the refusal.
    await expect(rowCountFor('session-partial')).resolves.toBe(1)
    await expect(rowCountFor('session-fresh')).resolves.toBe(3)
    await expect(markerPresent('session-fresh')).resolves.toBe(true)
    await expect(markerPresent('session-partial')).resolves.toBe(false)
    await assertChainIntact(journalDir)
  })
})

describe('migrateJournalFiles: a concurrent migrate run', () => {
  /** The record ids `sessionId` currently holds, in `seq` order — the byte-identity probe. */
  async function recordIdsOf(sessionId: string): Promise<readonly string[]> {
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    const rows = handle.db
      .prepare('SELECT record_id FROM journal_records WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as ReadonlyArray<{ record_id: string }>
    return rows.map((row) => row.record_id)
  }

  function staleRow(sessionId: string, index: number): JournalRecordRow {
    return {
      sessionId,
      recordId: `winner-${index}`,
      ts: new Date(index * 1000).toISOString(),
      direction: 'client→server',
      kind: 'notification',
      method: null,
      doc: `{"winner":${index}}`,
    }
  }

  test("rows already present when the outer loop checks leave the winner's committed rows byte-identical", async () => {
    // OLD expectation (pre-M5-task-3.4): a marker planted just before the
    // loser's first-batch transaction was the ONLY thing that stopped the
    // DELETE — proven here by mocking `handle.transaction` to plant the
    // marker at the exact moment the loser's batch takes the writer lock.
    // That mock is no longer needed to make this scenario safe: the outer
    // loop now refuses a session with rows and no marker BEFORE ever calling
    // `importOneFile`, so the winner's rows survive without depending on the
    // marker race being won at all — the assertion that matters (the winner's
    // rows are untouched) still holds, for a stronger reason than before.
    await writeLegacyFile('session-a', 3)
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    // What the run that won the race already committed, with no marker yet
    // (still mid-import from this run's point of view).
    handle.transaction((db) => insertRecordRows(db, [staleRow('session-a', 0), staleRow('session-a', 1)]))
    const before = await recordIdsOf('session-a')

    const result = await migrateJournalFiles(journalDir)

    expect(result).toEqual({ status: 'already-migrated', refusedSessions: ['session-a'] })
    expect(await recordIdsOf('session-a')).toEqual(before)
    await assertChainIntact(journalDir)
  })

  test('rows landing for a session between the outer check and the first batch taking the write lock are refused, not deleted', async () => {
    // The TOCTOU window the outer loop's `sessionHasRows` check cannot close
    // on its own: `commitBatch` re-checks inside the transaction, after the
    // write lock is held, so a writer that lands a row in this exact gap is
    // caught before the first batch's insert runs.
    await writeLegacyFile('session-a', 3)
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    const originalTransaction = handle.transaction
    let batchCalls = 0
    vi.spyOn(handle, 'transaction').mockImplementation((fn) => {
      batchCalls += 1
      if (batchCalls === 1) {
        // A concurrent writer's row lands after our outer-loop probe already
        // read "no rows", but before this transaction takes the write lock.
        handle.db.exec(
          "INSERT INTO journal_records (session_id, record_id, ts, direction, kind, method, doc) " +
            "VALUES ('session-a', 'concurrent-1', '1970-01-01T00:00:00.000Z', 'client→server', 'notification', NULL, '{\"concurrent\":true}')",
        )
      }
      return originalTransaction(fn)
    })

    const result = await migrateJournalFiles(journalDir)

    expect(batchCalls).toBe(1) // the first batch ran, saw the row, and refused — no second batch
    expect(result).toEqual({ status: 'already-migrated', refusedSessions: ['session-a'] })
    // The concurrent writer's row is exactly what remains: nothing from the
    // legacy file was inserted alongside or over it.
    const rows = await readJournalChainRows(journalDir, 'session-a')
    expect(rows.map((row) => row.doc)).toEqual(['{"concurrent":true}'])
    await assertChainIntact(journalDir)
  })

  test('a marker planted between batches stops the file without importing the second batch', async () => {
    const total = JOURNAL_BATCH_MAX_RECORDS + 44 // -> two batches: 256, then 44
    await writeLegacyFile('session-big', total)
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))

    const originalTransaction = handle.transaction
    let batchCalls = 0
    vi.spyOn(handle, 'transaction').mockImplementation((fn) => {
      batchCalls += 1
      const result = originalTransaction(fn)
      if (batchCalls === 1) {
        handle.db
          .prepare('INSERT OR IGNORE INTO imported_sessions (session_id) VALUES (?)')
          .run('session-big')
      }
      return result
    })

    const result = await migrateJournalFiles(journalDir)

    expect(batchCalls).toBe(2) // the second batch ran, saw the marker, and stopped
    expect(result).toEqual({ status: 'already-migrated', refusedSessions: [] })
    await expect(rowCountFor('session-big')).resolves.toBe(JOURNAL_BATCH_MAX_RECORDS)
    await assertChainIntact(journalDir)
  })
})

describe('listUnimportedLegacySessions', () => {
  test('an empty directory reports none', async () => {
    await expect(listUnimportedLegacySessions(journalDir)).resolves.toEqual([])
  })

  test('a directory with no database counts every legacy file', async () => {
    await writeLegacyFile('session-a', 1)
    await writeLegacyFile('session-b', 1)

    const unimported = await listUnimportedLegacySessions(journalDir)

    expect(unimported.sort()).toEqual(['session-a', 'session-b'])
  })

  test('a migrated session is excluded once its rows land in journal.db', async () => {
    await writeLegacyFile('session-a', 1)
    await writeLegacyFile('session-b', 1)
    await migrateJournalFiles(journalDir)

    await expect(listUnimportedLegacySessions(journalDir)).resolves.toEqual([])
  })

  test('a mix of imported and un-imported files reports only the un-imported ones', async () => {
    await writeLegacyFile('session-old', 1)
    await migrateJournalFiles(journalDir)
    await writeLegacyFile('session-new', 1)

    await expect(listUnimportedLegacySessions(journalDir)).resolves.toEqual(['session-new'])
  })

  test('a session imported with zero readable records (marker only) is still excluded', async () => {
    await writeFile(join(journalDir, 'session-garbage.jsonl'), 'not json\n', 'utf8')
    await migrateJournalFiles(journalDir)

    await expect(listUnimportedLegacySessions(journalDir)).resolves.toEqual([])
  })
})

describe('migrateJournalFiles: row identity', () => {
  test("a record whose embedded sessionId differs from the file name is filed under the file's id", async () => {
    const forged = JSON.stringify({
      id: '01AAAAAAAAAAAAAAAAAAAAAA0',
      ts: new Date(0).toISOString(),
      sessionId: 'session-other',
      direction: 'client→server',
      kind: 'notification',
      payload: { forged: true },
    })
    await writeFile(join(journalDir, 'session-file-owner.jsonl'), `${forged}\n`, 'utf8')

    const result = await migrateJournalFiles(journalDir)

    expect(result).toEqual({
      status: 'imported',
      recordCount: 1,
      sessionCount: 1,
      refusedSessions: [],
    })
    await expect(rowCountFor('session-file-owner')).resolves.toBe(1)
    await expect(rowCountFor('session-other')).resolves.toBe(0)

    const owned = await readSession('session-file-owner', { dir: journalDir })
    expect(owned).toHaveLength(1)
    const orphaned = await readSession('session-other', { dir: journalDir })
    expect(orphaned).toHaveLength(0)
  })
})

describe('migrateJournalFiles: refusal applies the same to a pre-chain database', () => {
  test('rows with NULL prev_hash/record_hash (written before the chain existed) are refused exactly like chained rows', async () => {
    // Decision (M5 task 3.4): one refusal rule for both a chained and a
    // pre-chain database, rather than skipping the refusal when nothing has
    // been chained yet. A pre-chain row without a marker is JUST as ambiguous
    // in origin as a chained one — the chain gives the DELETE a cryptographic
    // consequence, but the underlying question ("is this a genuine partial
    // import leftover, or something else with a legitimate reason to have
    // landed here?") is unanswerable from row/marker state alone either way,
    // so branching on chain state would only add a second code path to keep
    // correct for no safety benefit.
    await writeLegacyFile('session-a', 5)
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    // Written with the raw column list (no prev_hash/record_hash), the same
    // shape a database predating M5 wave 3 would hold for every row.
    handle.db.exec(
      "INSERT INTO journal_records (session_id, record_id, ts, direction, kind, method, doc) " +
        "VALUES ('session-a', 'pre-chain-1', '1970-01-01T00:00:00.000Z', 'client→server', 'notification', NULL, '{\"preChain\":true}')",
    )
    await expect(rowCountFor('session-a')).resolves.toBe(1)

    const result = await migrateJournalFiles(journalDir)

    expect(result).toEqual({ status: 'already-migrated', refusedSessions: ['session-a'] })
    const rows = await readJournalChainRows(journalDir, 'session-a')
    expect(rows).toEqual([{ prevHash: null, recordHash: null, doc: '{"preChain":true}' }])
  })
})
