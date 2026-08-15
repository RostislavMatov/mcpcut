import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { migrateJournalFiles } from '../../src/journal/import.js'
import {
  insertRecordRows,
  journalDbPathFor,
  openJournalDbShared,
  type JournalRecordRow,
} from '../../src/journal/db.js'
import { readSession } from '../../src/journal/reader.js'

/**
 * `migrateJournalFiles` (M4.5 wave 4, Task 7): bulk import of legacy
 * `*.jsonl` files into `journal.db`. Test structure mirrors
 * `tests/journal/db.test.ts` (mkdtemp + afterEach rm, direct SQL assertions
 * against the handle) plus behavioral assertions through the public reader,
 * which is what actually proves the routing decision (`read-routing.ts`)
 * serves an imported session from the database.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-import-test-'))
})

afterEach(async () => {
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

    expect(result).toEqual({ status: 'imported', recordCount: 5, sessionCount: 2 })
    await expect(markerPresent('session-a')).resolves.toBe(true)
    await expect(markerPresent('session-b')).resolves.toBe(true)

    // Reading through the public reader (not raw SQL) proves the read-routing
    // decision actually serves these sessions from journal.db now.
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

    expect(result).toEqual({ status: 'imported', recordCount: 2, sessionCount: 1 })
    await expect(rowCountFor('session-mixed')).resolves.toBe(2)
  })

  test('a file whose every line is malformed still gets a marker, contributing 0 records', async () => {
    await writeFile(
      join(journalDir, 'session-garbage.jsonl'),
      'not json\nalso not json\n{"still": "wrong shape"}\n',
      'utf8',
    )

    const result = await migrateJournalFiles(journalDir)

    expect(result).toEqual({ status: 'imported', recordCount: 0, sessionCount: 1 })
    await expect(markerPresent('session-garbage')).resolves.toBe(true)
    await expect(rowCountFor('session-garbage')).resolves.toBe(0)
  })
})

describe('migrateJournalFiles: idempotence', () => {
  test('re-running after a full import reports "already-migrated" and does not duplicate rows', async () => {
    await writeLegacyFile('session-a', 3)
    await migrateJournalFiles(journalDir)

    const second = await migrateJournalFiles(journalDir)

    expect(second).toEqual({ status: 'already-migrated' })
    await expect(rowCountFor('session-a')).resolves.toBe(3)
  })

  test('a killed-mid-file import (partial rows, no marker) is wiped and fully reloaded on re-run', async () => {
    await writeLegacyFile('session-a', 5)
    // Simulate a process killed between the first batch's DELETE+insert and
    // the file's final batch: partial rows exist, but no marker was ever
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

    expect(result).toEqual({ status: 'imported', recordCount: 5, sessionCount: 1 })
    // Exactly the file's own record count: the stale partial rows were wiped
    // by the first batch's DELETE, not added to.
    await expect(rowCountFor('session-a')).resolves.toBe(5)
  })
})

describe('migrateJournalFiles: mixed marker state', () => {
  test('one already-imported file plus one new file imports only the new one', async () => {
    await writeLegacyFile('session-old', 2)
    await migrateJournalFiles(journalDir)
    await writeLegacyFile('session-new', 4)

    const result = await migrateJournalFiles(journalDir)

    expect(result).toEqual({ status: 'imported', recordCount: 4, sessionCount: 1 })
    await expect(rowCountFor('session-old')).resolves.toBe(2)
    await expect(rowCountFor('session-new')).resolves.toBe(4)
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

    expect(result).toEqual({ status: 'imported', recordCount: 1, sessionCount: 1 })
    await expect(rowCountFor('session-file-owner')).resolves.toBe(1)
    await expect(rowCountFor('session-other')).resolves.toBe(0)

    const owned = await readSession('session-file-owner', { dir: journalDir })
    expect(owned).toHaveLength(1)
    const orphaned = await readSession('session-other', { dir: journalDir })
    expect(orphaned).toHaveLength(0)
  })
})
