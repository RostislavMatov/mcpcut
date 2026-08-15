import {
  insertRecordRows,
  journalDbPathFor,
  openJournalDbShared,
  type JournalDatabase,
  type JournalRecordRow,
} from './db.js'
import {
  defaultJournalReadDeps,
  journalPath,
  listSessionFilesNewestFirst,
  parseJournalLine,
} from './line-source.js'
import type { JournalRecord } from './record.js'
import { rethrowClassified } from '../policy/store-backend.js'
import { JOURNAL_BATCH_MAX_RECORDS } from '../config.js'
import type { SqliteHandle } from '../store/sqlite.js'

/**
 * Bulk, explicit import of legacy `*.jsonl` journal files into `journal.db`
 * (M4.5 wave 4). Driven by `mcp-journal migrate` (`src/cli/migrate-cmd.ts`),
 * never by a read: wave 3 chose LAZY import for the approvals queue because a
 * legacy file there is at most a few kilobytes, but a journal file can run to
 * gigabytes, and an unbounded import as the side effect of a UI page load or
 * a `journal show` is the wrong trade. Un-migrated sessions stay fully
 * readable through the merged read (`read-routing.ts`) in the meantime, so
 * running this command is a convenience, never a precondition.
 *
 * Idempotence is by wipe-and-reload, not by per-row `INSERT OR IGNORE`
 * (unlike the approvals queue): a file's FIRST batch opens with
 * `DELETE FROM journal_records WHERE session_id = ?`, and the
 * `imported_sessions` marker for that file is written in the SAME
 * transaction as its LAST batch. A process killed between those two points
 * leaves no marker, so a re-run treats the file as never-imported, wipes
 * whatever partial rows it left behind, and reloads it whole — simpler to
 * reason about than deduplicating by `record_id` across a partial and a full
 * pass. A file that fits in one batch gets the DELETE, the inserts and the
 * marker in a single transaction.
 *
 * Row identity: the file's own session id (its basename) becomes the row's
 * `session_id` column, never the `sessionId` field inside the parsed
 * record's `doc`. In every real journal the two agree, but the file name is
 * the identity this reader has trusted since M1 — accepting a record whose
 * embedded `sessionId` disagrees would let a forged or copied line escape
 * the session its file represents.
 */

/** Result `migrateJournalFiles` reports; mirrors the approvals queue's `{status, …counts}` shape. */
export type JournalMigrationResult =
  | { readonly status: 'imported'; readonly recordCount: number; readonly sessionCount: number }
  | { readonly status: 'already-migrated' }
  | { readonly status: 'no-files' }

const SELECT_MARKER = 'SELECT 1 FROM imported_sessions WHERE session_id = ?'
const INSERT_MARKER = 'INSERT OR IGNORE INTO imported_sessions (session_id) VALUES (?)'
const DELETE_SESSION_ROWS = 'DELETE FROM journal_records WHERE session_id = ?'

/** True when `sessionId` was already imported into this database (rows or marker alone). */
function markerPresent(db: JournalDatabase, sessionId: string): boolean {
  return db.prepare(SELECT_MARKER).get(sessionId) !== undefined
}

function writeMarker(db: JournalDatabase, sessionId: string): void {
  db.prepare(INSERT_MARKER).run(sessionId)
}

function deleteSessionRows(db: JournalDatabase, sessionId: string): void {
  db.prepare(DELETE_SESSION_ROWS).run(sessionId)
}

/**
 * Imports every not-yet-migrated legacy `*.jsonl` file in `journalDir`, oldest
 * modified first (the reverse of the read side's newest-first order): the
 * earliest traffic gets the lowest `seq` values, matching the order it was
 * originally recorded in.
 *
 * A missing `journalDir` and a directory with no `*.jsonl` files both answer
 * `no-files` without ever opening `journal.db` — a read-only probe must never
 * create the database (see `read-routing.ts`), and this is the one path that
 * legitimately does create it, but only once there is something to import.
 */
export async function migrateJournalFiles(journalDir: string): Promise<JournalMigrationResult> {
  const files = [...(await listSessionFilesNewestFirst(journalDir, defaultJournalReadDeps))].reverse()
  if (files.length === 0) {
    return { status: 'no-files' }
  }

  const dbPath = journalDbPathFor(journalDir)
  let handle: SqliteHandle
  try {
    handle = await openJournalDbShared(dbPath)
  } catch (error: unknown) {
    rethrowClassified(dbPath, error, true)
  }

  try {
    let recordCount = 0
    let sessionCount = 0
    for (const file of files) {
      if (markerPresent(handle.db, file.sessionId)) {
        continue // already migrated in an earlier run: not counted, not re-read
      }
      recordCount += await importOneFile(handle, journalDir, file.sessionId)
      sessionCount += 1
    }
    if (sessionCount === 0) {
      return { status: 'already-migrated' }
    }
    return { status: 'imported', recordCount, sessionCount }
  } catch (error: unknown) {
    rethrowClassified(dbPath, error)
  }
}

/**
 * Streams one file's lines through `parseJournalLine`, committing every
 * `JOURNAL_BATCH_MAX_RECORDS` valid rows in its own transaction, and returns
 * the number imported. A one-line lookahead after a full buffer decides
 * whether the batch just filled is also the file's last: without it, a file
 * whose record count is an exact multiple of the batch size would always
 * split its final batch from its marker into two transactions instead of
 * (correctly, for the exact-one-batch case) one.
 */
async function importOneFile(
  handle: SqliteHandle,
  journalDir: string,
  sessionId: string,
): Promise<number> {
  const filePath = journalPath(journalDir, sessionId)
  const lines = defaultJournalReadDeps.readLines(filePath)[Symbol.asyncIterator]()

  let isFirstBatch = true
  let recordCount = 0
  // Appended to in place rather than rebuilt per row: this is the hot path (a
  // line per imported record) and the array never escapes — a commit swaps it
  // for a fresh one, so no other holder can observe it change.
  let buffer: JournalRecordRow[] = []
  let pending: IteratorResult<string> | null = null

  for (;;) {
    const next = pending ?? (await lines.next())
    pending = null
    appendIfValid(buffer, sessionId, next)

    if (next.done === true) {
      recordCount += commitBatch(handle, sessionId, buffer, isFirstBatch, true)
      return recordCount
    }
    if (buffer.length < JOURNAL_BATCH_MAX_RECORDS) {
      continue
    }

    const lookahead = await lines.next()
    const isFinalBatch = lookahead.done === true
    recordCount += commitBatch(handle, sessionId, buffer, isFirstBatch, isFinalBatch)
    buffer = []
    isFirstBatch = false
    if (isFinalBatch) {
      return recordCount
    }
    pending = lookahead
  }
}

/** Pushes `next`'s line onto `buffer` as a row when it parses; a malformed or blank line is skipped. */
function appendIfValid(
  buffer: JournalRecordRow[],
  sessionId: string,
  next: IteratorResult<string>,
): void {
  if (next.done === true) {
    return
  }
  const record = parseJournalLine(next.value)
  if (record !== null) {
    buffer.push(rowOf(sessionId, record))
  }
}

/**
 * One file's batch: the DELETE (first batch only) and the marker (final
 * batch only) ride along with the inserts in the same transaction, so a
 * process killed mid-file never leaves the marker without its rows.
 */
function commitBatch(
  handle: SqliteHandle,
  sessionId: string,
  rows: readonly JournalRecordRow[],
  isFirstBatch: boolean,
  isFinalBatch: boolean,
): number {
  handle.transaction((db) => {
    if (isFirstBatch) {
      deleteSessionRows(db, sessionId)
    }
    if (rows.length > 0) {
      insertRecordRows(db, rows)
    }
    if (isFinalBatch) {
      writeMarker(db, sessionId)
    }
    return undefined
  })
  return rows.length
}

/**
 * The row a legacy record becomes: `sessionId` is the FILE's identity, not
 * `record.sessionId` (see the module doc). Column extraction otherwise
 * mirrors `sink.ts`'s `rowOf` exactly, so an imported row and a live-written
 * one are indistinguishable to every reader.
 */
function rowOf(sessionId: string, record: JournalRecord): JournalRecordRow {
  return {
    sessionId,
    recordId: record.id,
    ts: record.ts,
    direction: record.direction,
    kind: record.kind,
    method: record.method ?? null,
    doc: JSON.stringify(record),
  }
}
