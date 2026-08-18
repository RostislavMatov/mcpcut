import { copyFile, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { getBatchWriter, type SettleResult } from '../../src/journal/batch-writer.js'
import { GENESIS_PREV_HASH, linkHashOf } from '../../src/journal/chain.js'
import {
  insertRecordRows,
  JOURNAL_DB_FILE_NAME,
  journalDbPathFor,
  openJournalDbIfPresent,
  openJournalDbShared,
  type JournalRecordRow,
} from '../../src/journal/db.js'
import { openSqlite } from '../../src/store/sqlite.js'
import { readJournalChainRows } from '../support/journal-rows.js'

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

  test('journal_records has nullable prev_hash/record_hash chain columns (M5 wave 3)', async () => {
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))

    const columns = handle.db.prepare('PRAGMA table_info(journal_records)').all() as {
      name: string
      notnull: number
    }[]
    const byName = new Map(columns.map((column) => [column.name, column]))

    expect(byName.get('prev_hash')).toMatchObject({ notnull: 0 })
    expect(byName.get('record_hash')).toMatchObject({ notnull: 0 })
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
 * `insertRecordRows`'s hash chain (M5 wave 3, task 3.2): genesis, chaining
 * within and across batches, legacy (pre-chain) rows, concurrent writers,
 * and hash uniqueness. `linkHashOf` itself is unit-tested in isolation in
 * `chain.test.ts`; these tests are about the WIRING — the head read, the
 * in-memory fold, and the transaction boundary.
 */
describe('insertRecordRows: hash chain', () => {
  test('genesis: the first record in a fresh db has an empty prevHash and a recordHash from linkHashOf', async () => {
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    const row = makeRow({ doc: '{"hello":"world"}' })

    handle.transaction((db) => insertRecordRows(db, [row]))

    const [chained] = await readJournalChainRows(journalDir)
    expect(chained.prevHash).toBe(GENESIS_PREV_HASH)
    expect(chained.recordHash).toBe(linkHashOf(GENESIS_PREV_HASH, row.doc))
  })

  test('chains consecutive single-row batches: each prevHash equals the previous recordHash, and each recordHash re-derives from its own stored doc', async () => {
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    const docs = ['{"n":1}', '{"n":2}', '{"n":3}']
    for (const doc of docs) {
      handle.transaction((db) => insertRecordRows(db, [makeRow({ doc })]))
    }

    const rows = await readJournalChainRows(journalDir)
    expect(rows).toHaveLength(3)
    let expectedPrev: string = GENESIS_PREV_HASH
    for (const row of rows) {
      expect(row.prevHash).toBe(expectedPrev)
      expect(row.recordHash).toBe(linkHashOf(expectedPrev, row.doc))
      expectedPrev = row.recordHash as string
    }
  })

  test('a whole batch (multiple rows, one transaction) chains correctly within itself — the in-memory fold', async () => {
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    const rows: JournalRecordRow[] = [
      makeRow({ recordId: 'rec-1', doc: '{"n":1}' }),
      makeRow({ recordId: 'rec-2', doc: '{"n":2}' }),
      makeRow({ recordId: 'rec-3', doc: '{"n":3}' }),
    ]

    handle.transaction((db) => insertRecordRows(db, rows))

    const chained = await readJournalChainRows(journalDir)
    expect(chained).toHaveLength(3)
    expect(chained[0]?.prevHash).toBe(GENESIS_PREV_HASH)
    expect(chained[1]?.prevHash).toBe(chained[0]?.recordHash)
    expect(chained[2]?.prevHash).toBe(chained[1]?.recordHash)
  })

  test('two separate batches (transactions) chain across the batch boundary', async () => {
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))

    handle.transaction((db) =>
      insertRecordRows(db, [makeRow({ recordId: 'a-1', doc: '{"n":1}' }), makeRow({ recordId: 'a-2', doc: '{"n":2}' })]),
    )
    handle.transaction((db) =>
      insertRecordRows(db, [makeRow({ recordId: 'b-1', doc: '{"n":3}' }), makeRow({ recordId: 'b-2', doc: '{"n":4}' })]),
    )

    const chained = await readJournalChainRows(journalDir)
    expect(chained).toHaveLength(4)
    expect(chained[2]?.prevHash).toBe(chained[1]?.recordHash) // links across the batch boundary
    expect(chained[3]?.prevHash).toBe(chained[2]?.recordHash)
  })

  test('record_hash is unique across rows even when their doc content is identical — chain position differentiates them', async () => {
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    const doc = '{"same":"doc"}'

    handle.transaction((db) =>
      insertRecordRows(db, [makeRow({ recordId: 'r1', doc }), makeRow({ recordId: 'r2', doc })]),
    )

    const chained = await readJournalChainRows(journalDir)
    expect(chained[0]?.doc).toBe(doc)
    expect(chained[1]?.doc).toBe(doc)
    expect(chained[0]?.recordHash).not.toBe(chained[1]?.recordHash)
  })

  test('legacy rows (inserted before the chain existed) keep NULL prevHash/recordHash, and the next chained insert starts from genesis, not from NULL', async () => {
    const dbPath = journalDbPathFor(journalDir)
    // Simulates a pre-M5 database: the OLD table shape, no prev_hash/record_hash
    // columns at all, with one legacy row already in it.
    const rawHandle = await openSqlite(dbPath, { synchronous: 'full' })
    rawHandle.db.exec(
      'CREATE TABLE IF NOT EXISTS journal_records (' +
        'seq INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'session_id TEXT NOT NULL, record_id TEXT NOT NULL, ts TEXT NOT NULL, ' +
        'direction TEXT NOT NULL, kind TEXT NOT NULL, method TEXT, doc TEXT NOT NULL) STRICT',
    )
    rawHandle.transaction((db) => {
      db.prepare(
        'INSERT INTO journal_records (session_id, record_id, ts, direction, kind, method, doc) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('session-legacy', 'rec-legacy', new Date(0).toISOString(), 'client→server', 'notification', null, '{"legacy":true}')
      return undefined
    })
    rawHandle.close()

    // Opening through the real entry point must migrate the schema cleanly.
    const handle = await openJournalDbShared(dbPath)
    const columns = (handle.db.prepare('PRAGMA table_info(journal_records)').all() as { name: string }[]).map(
      (column) => column.name,
    )
    expect(columns).toEqual(expect.arrayContaining(['prev_hash', 'record_hash']))

    const beforeChaining = await readJournalChainRows(journalDir)
    expect(beforeChaining).toHaveLength(1)
    expect(beforeChaining[0]?.prevHash).toBeNull()
    expect(beforeChaining[0]?.recordHash).toBeNull()

    handle.transaction((db) => insertRecordRows(db, [makeRow({ recordId: 'rec-first-chained', doc: '{"chained":true}' })]))

    const afterChaining = await readJournalChainRows(journalDir)
    expect(afterChaining).toHaveLength(2)
    const firstChained = afterChaining[1]
    expect(firstChained?.prevHash).toBe(GENESIS_PREV_HASH) // NOT the legacy row's NULL
    expect(firstChained?.recordHash).toBe(linkHashOf(GENESIS_PREV_HASH, firstChained?.doc ?? ''))
  })

  test('the ALTER TABLE column migration is idempotent: opening an already-migrated database does not throw', async () => {
    const dbPath = journalDbPathFor(journalDir)
    const handle = await openJournalDbShared(dbPath)
    handle.transaction((db) => insertRecordRows(db, [makeRow()]))
    // Force everything out of the WAL and into the main file so a plain file
    // copy below is a complete, self-contained database.
    handle.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')

    const migratedDir = await mkdtemp(join(tmpdir(), 'mcp-journal-db-test-migrated-'))
    try {
      await copyFile(dbPath, journalDbPathFor(migratedDir))

      // A fresh dbPath forces a real (non-cached) call into the open/migrate
      // path against a database that ALREADY has both chain columns — this
      // is what proves the guard is a no-op rather than throwing on the
      // already-migrated case.
      const reopened = await openJournalDbShared(journalDbPathFor(migratedDir))
      const columns = (reopened.db.prepare('PRAGMA table_info(journal_records)').all() as { name: string }[]).map(
        (column) => column.name,
      )
      expect(columns).toEqual(expect.arrayContaining(['prev_hash', 'record_hash']))
    } finally {
      await rm(migratedDir, { recursive: true, force: true })
    }
  })

  test('two interleaved writers (separate connections to the same file) produce one unbroken chain, no fork', async () => {
    const dbPath = journalDbPathFor(journalDir)
    // Two independent SqliteHandles against the SAME file model two
    // concurrent sinks (two processes) rather than two callers sharing one
    // process-cached handle. `BEGIN IMMEDIATE` serializes them at the SQLite
    // level; what this test checks is that the RESULT is one unbroken chain
    // regardless of which writer committed which row.
    //
    // CORRECTION (review finding, M5 waves 3-4 review round): the five
    // `handle.transaction(...)` calls below run strictly SEQUENTIALLY — each
    // one returns before the next starts, so no two of them ever actually
    // contend for the write lock, and `SQLITE_BUSY` never fires here. This
    // test therefore does NOT exercise the plan's actual highest-risk
    // scenario (a busy-retried write replaying `insertRecordRows` and
    // needing to re-read the chain head under the NEW lock, or forking the
    // chain). It still earns its keep as a "two connections, no accidental
    // cross-talk" sanity check; the real contention case is the dedicated
    // test below this one, which forces a genuine `SQLITE_BUSY`
    // deterministically.
    // Bootstraps the schema first (mirrors what a real first-ever writer's
    // process does before either sink touches the file): raw `openSqlite`
    // below is the storage primitive alone and runs no DDL of its own.
    await openJournalDbShared(dbPath)
    const writerA = await openSqlite(dbPath, { synchronous: 'full' })
    const writerB = await openSqlite(dbPath, { synchronous: 'full' })
    try {
      writerA.transaction((db) => insertRecordRows(db, [makeRow({ recordId: 'a-1', doc: '{"w":"a1"}' })]))
      writerB.transaction((db) => insertRecordRows(db, [makeRow({ recordId: 'b-1', doc: '{"w":"b1"}' })]))
      writerA.transaction((db) => insertRecordRows(db, [makeRow({ recordId: 'a-2', doc: '{"w":"a2"}' })]))
      writerB.transaction((db) =>
        insertRecordRows(db, [
          makeRow({ recordId: 'b-2', doc: '{"w":"b2"}' }),
          makeRow({ recordId: 'b-3', doc: '{"w":"b3"}' }),
        ]),
      )
      writerA.transaction((db) => insertRecordRows(db, [makeRow({ recordId: 'a-3', doc: '{"w":"a3"}' })]))
    } finally {
      writerA.close()
      writerB.close()
    }

    const rows = await readJournalChainRows(journalDir)
    expect(rows).toHaveLength(6)
    let expectedPrev: string = GENESIS_PREV_HASH
    const seenHashes = new Set<string>()
    for (const row of rows) {
      expect(row.prevHash).toBe(expectedPrev)
      expect(row.recordHash).toBe(linkHashOf(expectedPrev, row.doc))
      expect(seenHashes.has(row.recordHash as string)).toBe(false) // no duplicate recordHash = no fork
      seenHashes.add(row.recordHash as string)
      expectedPrev = row.recordHash as string
    }
  })

  test('a busy-retried write via the batch writer re-reads the chain head on retry, so a genuinely contended commit still produces one unbroken chain', async () => {
    const dbPath = journalDbPathFor(journalDir)
    // Bootstraps the schema AND becomes the connection `getBatchWriter`'s
    // production commit path (`batch-writer.ts`'s `commitToDatabase`) will
    // reuse via the process-wide shared-handle cache (`openJournalDbShared`).
    await openJournalDbShared(dbPath)

    // A second, independent connection (models a concurrent second process,
    // same as the test above) that takes and HOLDS the write lock across a
    // real async delay -- something `handle.transaction()` cannot do itself
    // (its callback must be synchronous, see `store/sqlite.ts`), so this
    // goes around it directly: `BEGIN IMMEDIATE` + the real `insertRecordRows`
    // + a deliberately delayed `COMMIT`.
    const holder = await openSqlite(dbPath, { synchronous: 'full' })
    try {
      holder.db.exec('BEGIN IMMEDIATE')
      insertRecordRows(holder.db, [makeRow({ recordId: 'holder-1', doc: '{"w":"holder"}' })])

      // The journal connection's OWN sqlite `busy_timeout` is 50ms
      // (`JOURNAL_STATEMENT_BUSY_TIMEOUT_MS`, db.ts) -- holding the lock for
      // 300ms is well over 5x that, so this GUARANTEES a real `SQLITE_BUSY`
      // is thrown at the sqlite level and caught by `batch-writer.ts`'s
      // `withBusyRetries` at least once before we release below. That
      // guarantee comes from sqlite's own fixed timeout, not from timing
      // luck, so it is not flaky.
      const writer = getBatchWriter(dbPath)
      const settled: SettleResult[] = []
      writer.enqueue(makeRow({ recordId: 'contender-1', doc: '{"w":"contender"}' }), (result) => {
        settled.push(result)
      })
      let hasFlushed = false
      const flushPromise = writer.flushNow()
      void flushPromise.then(() => {
        hasFlushed = true
      })

      const holdMs = 300
      await new Promise((resolve) => setTimeout(resolve, holdMs))
      // Direct evidence of real contention, not an assumption: the writer's
      // flush is still pending after `holdMs` while the lock is held. A
      // fast/no-op path (or a bug that gave up after the first busy failure
      // instead of retrying) would have already resolved by now.
      expect(hasFlushed).toBe(false)

      holder.db.exec('COMMIT')
      await flushPromise

      expect(settled).toEqual([{ ok: true }])

      // Correctness: the retried attempt must have read the chain head AFTER
      // the holder's commit landed, not the stale (genesis) head captured
      // before contention began -- otherwise this is exactly the fork the
      // plan calls its highest-risk scenario. `insertRecordRows`'s head read
      // happens inside the transaction callback, re-run on every retry
      // (see its own doc in db.ts); this is what proves that in practice,
      // not just by inspection.
      const rows = await readJournalChainRows(journalDir)
      expect(rows).toHaveLength(2)
      expect(rows[0]?.recordHash).toBe(linkHashOf(GENESIS_PREV_HASH, rows[0]?.doc ?? ''))
      expect(rows[1]?.prevHash).toBe(rows[0]?.recordHash) // fresh head, not a stale/forked one
      expect(rows[1]?.recordHash).toBe(linkHashOf(rows[1]?.prevHash ?? '', rows[1]?.doc ?? ''))
    } finally {
      holder.close()
    }
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
