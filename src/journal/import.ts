import {
  insertRecordRows,
  journalDbPathFor,
  openJournalDbIfPresent,
  openJournalDbShared,
  type JournalDatabase,
  type JournalRecordRow,
} from './db.js'
import { dbHasSession } from './db-read.js'
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
 * a `journal show` is the wrong trade. Since wave 5 cut the merged
 * DB+file read arm, an un-migrated session is invisible to every reader
 * (`sessions`, `show`, `export`, search — `journal.db` only) until this
 * runs; the CLI surfaces a stderr hint (`listUnimportedLegacySessions`,
 * below) when un-imported files exist, but running this command is a nudge,
 * not an enforced precondition — nothing stops the proxy itself from
 * writing brand-new sessions straight to `journal.db` in the meantime.
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
 * marker in a single transaction. Two `migrate` runs racing on the same
 * directory are safe because every batch re-reads the marker inside its own
 * transaction before deleting anything (`commitBatch`).
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
 * create the database (see `openJournalDbIfPresent` in `db.ts`), and this is
 * the one path that legitimately does create it, but only once there is
 * something to import.
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
      const imported = await importOneFile(handle, journalDir, file.sessionId)
      if (imported === null) {
        continue // a concurrent run owns this session (see `commitBatch`): reported as a skip
      }
      recordCount += imported
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
 * Legacy `*.jsonl` session files not yet reflected in `journal.db` — the
 * CLI hint's probe (`journal-cmds.ts`, wave 5 task 6). A directory with no
 * database counts every legacy file, since nothing has been imported yet; an
 * existing database excludes any session `dbHasSession` already claims (rows
 * or its import marker alone — the same routing question `reader.ts` asks).
 * A directory with no legacy files short-circuits before ever opening the
 * database, matching the read-side rule that a probe must not create it.
 */
export async function listUnimportedLegacySessions(journalDir: string): Promise<readonly string[]> {
  const files = await listSessionFilesNewestFirst(journalDir, defaultJournalReadDeps)
  if (files.length === 0) {
    return []
  }
  const handle = await openJournalDbIfPresent(journalDir)
  if (handle === null) {
    return files.map((file) => file.sessionId)
  }
  return files.filter((file) => !dbHasSession(handle, file.sessionId)).map((file) => file.sessionId)
}

/**
 * Streams one file's lines through `parseJournalLine`, committing every
 * `JOURNAL_BATCH_MAX_RECORDS` valid rows in its own transaction, and returns
 * the number imported — or `null` when a batch found the session already
 * marked, i.e. a concurrent run owns it (see `commitBatch`). A one-line
 * lookahead after a full buffer decides whether the batch just filled is also
 * the file's last: without it, a file whose record count is an exact multiple
 * of the batch size would always split its final batch from its marker into
 * two transactions instead of (correctly, for the exact-one-batch case) one.
 */
async function importOneFile(
  handle: SqliteHandle,
  journalDir: string,
  sessionId: string,
): Promise<number | null> {
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
      const committed = commitBatch(handle, sessionId, buffer, isFirstBatch, true)
      return committed === null ? null : recordCount + committed
    }
    if (buffer.length < JOURNAL_BATCH_MAX_RECORDS) {
      continue
    }

    const lookahead = await lines.next()
    const isFinalBatch = lookahead.done === true
    const committed = commitBatch(handle, sessionId, buffer, isFirstBatch, isFinalBatch)
    if (committed === null) {
      return null
    }
    recordCount += committed
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
 *
 * The marker is re-checked as the FIRST statement of EVERY batch's
 * transaction, mirroring `insertLegacyChunk` (`policy/approvals/queue-import.ts`),
 * and answers `null` when it is already there. Without it, two concurrent
 * `migrate` runs can both pass the check in `migrateJournalFiles` — which is
 * outside any transaction — and the loser's first-batch DELETE would then
 * wipe rows the winner has already committed: silent loss of journal records,
 * the one thing an append-oriented journal must never do. The DELETE stays
 * the idempotency mechanism for a genuinely un-imported session; the
 * re-check is what makes it safe to run.
 */
function commitBatch(
  handle: SqliteHandle,
  sessionId: string,
  rows: readonly JournalRecordRow[],
  isFirstBatch: boolean,
  isFinalBatch: boolean,
): number | null {
  return handle.transaction((db) => {
    if (markerPresent(db, sessionId)) {
      return null
    }
    if (isFirstBatch) {
      deleteSessionRows(db, sessionId)
    }
    if (rows.length > 0) {
      insertRecordRows(db, rows)
    }
    if (isFinalBatch) {
      writeMarker(db, sessionId)
    }
    return rows.length
  })
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
