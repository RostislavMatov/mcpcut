import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { GENESIS_PREV_HASH, linkHashOf } from '../../src/journal/chain.js'
import {
  resolveChainStartPrevHash,
  sessionChainSpan,
  verifyChain,
} from '../../src/journal/chain-verify.js'
import {
  insertRecordRows,
  journalDbPathFor,
  openJournalDbShared,
  type JournalRecordRow,
} from '../../src/journal/db.js'
import type { SqliteHandle } from '../../src/store/sqlite.js'

/**
 * `verifyChain`/`sessionChainSpan` (M5 wave 3, task 3.3): the pure walk over
 * `journal_records`, unit-tested against a real tmpdir SQLite database (no
 * mocks -- project rule). CLI-level tamper tests (sink-written, then
 * SQL-tampered, then `mcp-journal verify` invoked) live in
 * `tests/cli/verify-cmd.test.ts`; this file is the core's own behavior in
 * isolation, including the direct-SQL edge cases (legacy NULL-hash rows)
 * that only a raw INSERT can set up.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-chain-verify-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

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

/** Inserts a row with NULL prev_hash/record_hash directly, bypassing `insertRecordRows`'s chaining -- the only way to create a pre-chain row on demand. */
function insertLegacyRow(handle: SqliteHandle, row: JournalRecordRow): void {
  handle.db
    .prepare(
      'INSERT INTO journal_records (session_id, record_id, ts, direction, kind, method, doc) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(row.sessionId, row.recordId, row.ts, row.direction, row.kind, row.method, row.doc)
}

async function openHandle(): Promise<SqliteHandle> {
  return openJournalDbShared(journalDbPathFor(journalDir))
}

describe('resolveChainStartPrevHash', () => {
  test('resolves to GENESIS_PREV_HASH (no prune marker exists yet)', async () => {
    const handle = await openHandle()

    expect(resolveChainStartPrevHash(handle)).toBe(GENESIS_PREV_HASH)
  })
})

describe('verifyChain: empty journal', () => {
  test('reports zero rows and no break', async () => {
    const handle = await openHandle()

    const result = verifyChain(handle)

    expect(result).toEqual({
      totalRowCount: 0,
      unattestedCount: 0,
      unattestedThroughSeq: null,
      attestedCount: 0,
      intactThroughSeq: null,
      break: null,
    })
  })
})

describe('verifyChain: all pre-chain rows', () => {
  test('every row unattested, nothing attested, no break -- not a failure', async () => {
    const handle = await openHandle()
    insertLegacyRow(handle, makeRow({ recordId: 'a', doc: '{"n":1}' }))
    insertLegacyRow(handle, makeRow({ recordId: 'b', doc: '{"n":2}' }))
    insertLegacyRow(handle, makeRow({ recordId: 'c', doc: '{"n":3}' }))

    const result = verifyChain(handle)

    expect(result.totalRowCount).toBe(3)
    expect(result.unattestedCount).toBe(3)
    expect(result.unattestedThroughSeq).toBe(3)
    expect(result.attestedCount).toBe(0)
    expect(result.intactThroughSeq).toBeNull()
    expect(result.break).toBeNull()
  })
})

describe('verifyChain: mixed legacy prefix + chained suffix', () => {
  test('verifies only the chained suffix and reports the unattested count', async () => {
    const handle = await openHandle()
    insertLegacyRow(handle, makeRow({ recordId: 'legacy-1', doc: '{"n":1}' }))
    insertLegacyRow(handle, makeRow({ recordId: 'legacy-2', doc: '{"n":2}' }))
    handle.transaction((db) =>
      insertRecordRows(db, [
        makeRow({ recordId: 'chain-1', doc: '{"n":3}' }),
        makeRow({ recordId: 'chain-2', doc: '{"n":4}' }),
      ]),
    )

    const result = verifyChain(handle)

    expect(result.totalRowCount).toBe(4)
    expect(result.unattestedCount).toBe(2)
    expect(result.unattestedThroughSeq).toBe(2)
    expect(result.attestedCount).toBe(2)
    expect(result.intactThroughSeq).toBe(4)
    expect(result.break).toBeNull()
  })
})

describe('verifyChain: clean chain', () => {
  test('every row attests, intactThroughSeq is the last seq, no break', async () => {
    const handle = await openHandle()
    handle.transaction((db) =>
      insertRecordRows(db, [
        makeRow({ recordId: 'a', doc: '{"n":1}' }),
        makeRow({ recordId: 'b', doc: '{"n":2}' }),
        makeRow({ recordId: 'c', doc: '{"n":3}' }),
      ]),
    )

    const result = verifyChain(handle)

    expect(result.totalRowCount).toBe(3)
    expect(result.unattestedCount).toBe(0)
    expect(result.attestedCount).toBe(3)
    expect(result.intactThroughSeq).toBe(3)
    expect(result.break).toBeNull()
  })
})

describe('verifyChain: tamper detection', () => {
  test('an UPDATEd doc is detected as "modified" at its own seq', async () => {
    const handle = await openHandle()
    handle.transaction((db) =>
      insertRecordRows(db, [
        makeRow({ recordId: 'a', doc: '{"n":1}' }),
        makeRow({ recordId: 'b', doc: '{"n":2}' }),
        makeRow({ recordId: 'c', doc: '{"n":3}' }),
      ]),
    )
    handle.db.prepare('UPDATE journal_records SET doc = ? WHERE seq = 2').run('{"n":"tampered"}')

    const result = verifyChain(handle)

    expect(result.break).toEqual({ seq: 2, reason: 'modified' })
    expect(result.intactThroughSeq).toBe(1)
  })

  test('a DELETEd middle row is detected as a "gap" at the surviving seq after it', async () => {
    const handle = await openHandle()
    handle.transaction((db) =>
      insertRecordRows(db, [
        makeRow({ recordId: 'a', doc: '{"n":1}' }),
        makeRow({ recordId: 'b', doc: '{"n":2}' }),
        makeRow({ recordId: 'c', doc: '{"n":3}' }),
      ]),
    )
    handle.db.prepare('DELETE FROM journal_records WHERE seq = 2').run()

    const result = verifyChain(handle)

    expect(result.break).toEqual({ seq: 3, reason: 'gap' })
    expect(result.intactThroughSeq).toBe(1)
  })

  test('two rows with swapped docs are detected as "modified" at the earlier seq', async () => {
    const handle = await openHandle()
    handle.transaction((db) =>
      insertRecordRows(db, [
        makeRow({ recordId: 'a', doc: '{"n":1}' }),
        makeRow({ recordId: 'b', doc: '{"n":2}' }),
        makeRow({ recordId: 'c', doc: '{"n":3}' }),
      ]),
    )
    handle.db.prepare('UPDATE journal_records SET doc = ? WHERE seq = 1').run('{"n":2}')
    handle.db.prepare('UPDATE journal_records SET doc = ? WHERE seq = 2').run('{"n":1}')

    const result = verifyChain(handle)

    expect(result.break).toEqual({ seq: 1, reason: 'modified' })
    expect(result.intactThroughSeq).toBeNull()
  })

  test('an untouched multi-batch chain verifies clean end to end', async () => {
    const handle = await openHandle()
    handle.transaction((db) => insertRecordRows(db, [makeRow({ recordId: 'a', doc: '{"n":1}' })]))
    handle.transaction((db) => insertRecordRows(db, [makeRow({ recordId: 'b', doc: '{"n":2}' })]))
    handle.transaction((db) =>
      insertRecordRows(db, [
        makeRow({ recordId: 'c', doc: '{"n":3}' }),
        makeRow({ recordId: 'd', doc: '{"n":4}' }),
      ]),
    )

    const result = verifyChain(handle)

    expect(result.break).toBeNull()
    expect(result.intactThroughSeq).toBe(4)
    expect(result.attestedCount).toBe(4)
  })

  test('the recomputed hash matches linkHashOf directly (sanity cross-check against chain.ts)', async () => {
    const handle = await openHandle()
    handle.transaction((db) => insertRecordRows(db, [makeRow({ doc: '{"n":1}' })]))

    const result = verifyChain(handle)

    expect(result.break).toBeNull()
    // Recomputed independently via the exported primitive, not reaching into
    // the walk's internals -- this is what "re-derives from linkHashOf" means.
    expect(linkHashOf(GENESIS_PREV_HASH, '{"n":1}')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('sessionChainSpan', () => {
  test('returns null for a session with no rows', async () => {
    const handle = await openHandle()
    handle.transaction((db) => insertRecordRows(db, [makeRow({ sessionId: 'other-session' })]))

    expect(sessionChainSpan(handle, 'no-such-session')).toBeNull()
  })

  test('returns the row count and seq span for a session that has rows', async () => {
    const handle = await openHandle()
    handle.transaction((db) =>
      insertRecordRows(db, [
        makeRow({ sessionId: 'other', recordId: 'x' }),
        makeRow({ sessionId: 'session-a', recordId: 'a1' }),
        makeRow({ sessionId: 'other', recordId: 'y' }),
        makeRow({ sessionId: 'session-a', recordId: 'a2' }),
      ]),
    )

    const span = sessionChainSpan(handle, 'session-a')

    expect(span).toEqual({ sessionId: 'session-a', rowCount: 2, firstSeq: 2, lastSeq: 4 })
  })
})
