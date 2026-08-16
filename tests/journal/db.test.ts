import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  insertRecordRows,
  JOURNAL_DB_FILE_NAME,
  journalDbPathFor,
  openJournalDbIfPresent,
  openJournalDbShared,
  type JournalRecordRow,
} from '../../src/journal/db.js'
import { openSqlite } from '../../src/store/sqlite.js'

/**
 * The storage substrate of the journal (M4.5 wave 4, ADR-0006): `journal.db`
 * schema, shared per-process connection, and the raw row insert helper. Test
 * structure mirrors `tests/policy/approvals/queue-db.test.ts` (mkdtemp +
 * afterEach rm, direct SQL assertions against the handle).
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-db-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function tableNames(db: Awaited<ReturnType<typeof openJournalDbShared>>): string[] {
  const rows = db.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[]
  return rows.map((row) => row.name)
}

function makeRow(overrides: Partial<JournalRecordRow> = {}): JournalRecordRow {
  return {
    sessionId: 'session-1',
    recordId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: new Date(0).toISOString(),
    direction: 'client→server',
    kind: 'notification',
    method: 'tools/call',
    doc: '{"hello":"world"}',
    ...overrides,
  }
}

describe('openJournalDbShared: schema', () => {
  test('creates journal.db with the journal_records and imported_sessions tables', async () => {
    const dbPath = journalDbPathFor(journalDir)

    const handle = await openJournalDbShared(dbPath)

    await expect(stat(dbPath)).resolves.toBeDefined()
    expect(tableNames(handle)).toEqual(
      expect.arrayContaining(['journal_records', 'imported_sessions']),
    )
  })

  test('re-opening the same path is idempotent (no error, same schema)', async () => {
    const dbPath = journalDbPathFor(journalDir)

    const first = await openJournalDbShared(dbPath)
    await expect(openJournalDbShared(dbPath)).resolves.toBeDefined()

    expect(tableNames(first)).toEqual(
      expect.arrayContaining(['journal_records', 'imported_sessions']),
    )
  })

  test('the journal_records table is STRICT and rejects a non-text doc', async () => {
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))

    // STRICT's TEXT column accepts INTEGER/REAL (auto-converted to text) but
    // rejects BLOB outright — the shape of "not text" that actually throws.
    expect(() =>
      handle.db
        .prepare(
          'INSERT INTO journal_records (session_id, record_id, ts, direction, kind, method, doc) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'session-1',
          'rec-1',
          new Date(0).toISOString(),
          'client→server',
          'notification',
          null,
          Buffer.from('not text'),
        ),
    ).toThrow()
  })

  test('database file mode is 0600 (regression guard on the shared adapter)', async () => {
    const dbPath = journalDbPathFor(journalDir)

    await openJournalDbShared(dbPath)

    const fileStat = await stat(dbPath)
    expect(fileStat.mode & 0o777).toBe(0o600)
  })
})

describe('openJournalDbShared: per-process cache', () => {
  test('a second open of the same path returns the same handle', async () => {
    const dbPath = journalDbPathFor(journalDir)

    const first = await openJournalDbShared(dbPath)
    const second = await openJournalDbShared(dbPath)

    expect(second).toBe(first)
  })

  test('two different paths get two distinct handles', async () => {
    const otherDir = await mkdtemp(join(tmpdir(), 'mcp-journal-db-test-other-'))
    try {
      const a = await openJournalDbShared(journalDbPathFor(journalDir))
      const b = await openJournalDbShared(journalDbPathFor(otherDir))

      expect(a).not.toBe(b)
    } finally {
      await rm(otherDir, { recursive: true, force: true })
    }
  })
})

describe('seq: AUTOINCREMENT never reuses a value after DELETE', () => {
  test('a fresh insert after deleting the max-seq row gets a strictly larger seq', async () => {
    const dbPath = journalDbPathFor(journalDir)
    const handle = await openJournalDbShared(dbPath)

    handle.transaction((db) => insertRecordRows(db, [makeRow(), makeRow()]))
    const beforeDelete = handle.db
      .prepare('SELECT MAX(seq) AS maxSeq FROM journal_records')
      .get() as { maxSeq: number }
    expect(beforeDelete.maxSeq).toBe(2)

    handle.transaction((db) => {
      db.prepare('DELETE FROM journal_records WHERE seq = ?').run(beforeDelete.maxSeq)
      return undefined
    })

    handle.transaction((db) => insertRecordRows(db, [makeRow()]))
    const afterReinsert = handle.db
      .prepare('SELECT seq FROM journal_records ORDER BY seq DESC LIMIT 1')
      .get() as { seq: number }

    expect(afterReinsert.seq).toBeGreaterThan(beforeDelete.maxSeq)
    expect(afterReinsert.seq).toBe(3)
  })

  test('seq strictly grows across multiple inserted batches', async () => {
    const dbPath = journalDbPathFor(journalDir)
    const handle = await openJournalDbShared(dbPath)

    handle.transaction((db) => insertRecordRows(db, [makeRow()]))
    handle.transaction((db) => insertRecordRows(db, [makeRow(), makeRow()]))
    handle.transaction((db) => insertRecordRows(db, [makeRow()]))

    const seqs = (
      handle.db.prepare('SELECT seq FROM journal_records ORDER BY seq').all() as {
        seq: number
      }[]
    ).map((row) => row.seq)

    expect(seqs).toEqual([1, 2, 3, 4])
  })
})

describe('journal.db coexists with state.db in one directory', () => {
  test('both databases exist as separate files and both are usable', async () => {
    const journalHandle = await openJournalDbShared(journalDbPathFor(journalDir))
    const stateDbPath = join(journalDir, 'state.db')
    const stateHandle = await openSqlite(stateDbPath, { synchronous: 'normal' })
    try {
      stateHandle.db.exec(
        'CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, doc TEXT NOT NULL) STRICT',
      )
      stateHandle.transaction((db) => {
        db.prepare('INSERT INTO documents (name, doc) VALUES (?, ?)').run('agents.json', '{}')
        return undefined
      })
      journalHandle.transaction((db) => insertRecordRows(db, [makeRow()]))

      await expect(stat(journalDbPathFor(journalDir))).resolves.toBeDefined()
      await expect(stat(stateDbPath)).resolves.toBeDefined()

      const journalCount = journalHandle.db
        .prepare('SELECT COUNT(*) AS n FROM journal_records')
        .get() as { n: number }
      const stateCount = stateHandle.db.prepare('SELECT COUNT(*) AS n FROM documents').get() as {
        n: number
      }
      expect(journalCount.n).toBe(1)
      expect(stateCount.n).toBe(1)
    } finally {
      stateHandle.close()
    }
  })
})

describe('insertRecordRows', () => {
  test('inserts a batch of rows inside handle.transaction and they are SELECTable', async () => {
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    const rows: JournalRecordRow[] = [
      makeRow({ recordId: 'rec-1', kind: 'notification' }),
      makeRow({ recordId: 'rec-2', kind: 'decision', method: null }),
      makeRow({ recordId: 'rec-3', kind: 'response' }),
    ]

    handle.transaction((db) => insertRecordRows(db, rows))

    const selected = handle.db
      .prepare(
        'SELECT session_id AS sessionId, record_id AS recordId, ts, direction, kind, method, doc ' +
          'FROM journal_records ORDER BY seq',
      )
      .all() as JournalRecordRow[]

    expect(selected).toEqual(rows)
  })

  test('an empty batch is a no-op', async () => {
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))

    expect(() => handle.transaction((db) => insertRecordRows(db, []))).not.toThrow()

    const count = handle.db.prepare('SELECT COUNT(*) AS n FROM journal_records').get() as {
      n: number
    }
    expect(count.n).toBe(0)
  })
})

/**
 * The probe every read entry point goes through (moved here from the deleted
 * `read-routing.test.ts` with the function itself, M4.5 wave 5). Its whole
 * point is what it does NOT do: an empty database created by a read would
 * answer "yes, I am the carrier" for every future check and silence a
 * pure-legacy install's journal.
 */
describe('openJournalDbIfPresent', () => {
  test('returns null for a directory with no journal.db, and creates none', async () => {
    await writeFile(join(journalDir, 'legacy-only.jsonl'), '', 'utf8')

    const handle = await openJournalDbIfPresent(journalDir)

    expect(handle).toBeNull()
    const entries = await readdir(journalDir)
    expect(entries).toEqual(['legacy-only.jsonl'])
    expect(entries.some((name) => name.startsWith(JOURNAL_DB_FILE_NAME))).toBe(false)
  })

  test('returns null for a directory that does not exist', async () => {
    await expect(openJournalDbIfPresent(join(journalDir, 'nope'))).resolves.toBeNull()
  })

  test('returns the shared handle once journal.db exists', async () => {
    const opened = await openJournalDbShared(journalDbPathFor(journalDir))

    const probed = await openJournalDbIfPresent(journalDir)

    expect(probed).toBe(opened)
  })
})
