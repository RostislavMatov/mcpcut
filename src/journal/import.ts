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
 * Idempotence was originally wipe-and-reload: a file's first batch opened
 * with `DELETE FROM journal_records WHERE session_id = ?`, and the
 * `imported_sessions` marker landed with its last batch, so a process killed
 * partway through left orphan rows with no marker that a re-run would wipe
 * and reload whole. M5 wave 3 added a hash chain across `journal_records`
 * (`db.ts`'s `insertRecordRows`, folded in insertion order) and that DELETE
 * became actively destructive: removing rows from the middle of the chain
 * breaks every `record_hash` computed after them, permanently, with no way
 * for `verify` (a later wave) to say anything more useful than "broken
 * somewhere" — the DELETE would have silently forfeited the journal's one
 * job. So the marker is now a REFUSAL to re-import, never a trigger to
 * reload:
 *
 * - **marker present**: this file's session is already fully imported. The
 *   outer loop skips it — no read, no write, no delete — exactly as before;
 *   only the reasoning above changed, not this path's behavior.
 * - **marker absent but the session already has rows in `journal.db`**: this
 *   is the case the DELETE used to "fix" by wiping and reloading. There is no
 *   reliable way, from the row/marker state alone, to tell a killed-mid-file
 *   import apart from anything else that could leave a session with rows and
 *   no marker (a concurrent `migrate` still running is the other case this
 *   module knows about — see `sessionHasRows` below). Rather than guess,
 *   `migrateJournalFiles` REFUSES the file: the session id is reported in
 *   `JournalMigrationResult.refusedSessions`, nothing is read or written for
 *   it, and the CLI (`migrate-cmd.ts`) turns that into a stderr warning and a
 *   non-zero exit — while still importing every OTHER file in the directory.
 *
 * The same refusal applies whether or not the database has ever written a
 * chained row (some installs still hold only pre-chain `NULL`-hash rows — see
 * `db.ts`'s module doc). One rule for both is deliberate: an operator cannot
 * easily tell from the outside whether a given `journal.db` has started
 * chaining, and a journal that is "append-oriented evidence, not
 * authorization state" (this module's own framing) should not silently
 * delete rows of ambiguous origin even before a chain gives that a
 * cryptographic consequence — simplicity and safety point the same way here,
 * so there is no second, DELETE-based code path to keep correct.
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
  | {
      readonly status: 'imported'
      readonly recordCount: number
      readonly sessionCount: number
      /** Session ids refused because rows already existed with no marker; see the module doc. */
      readonly refusedSessions: readonly string[]
    }
  | {
      readonly status: 'already-migrated'
      readonly refusedSessions: readonly string[]
    }
  | { readonly status: 'no-files' }

/** What one file's import attempt settled on: a normal commit, a race lost to a
 * concurrent run that finished first, or a refusal (see the module doc). */
type ImportOutcome =
  | { readonly kind: 'imported'; readonly recordCount: number }
  | { readonly kind: 'already-migrated' }
  | { readonly kind: 'refused' }

const SELECT_MARKER = 'SELECT 1 FROM imported_sessions WHERE session_id = ?'
const INSERT_MARKER = 'INSERT OR IGNORE INTO imported_sessions (session_id) VALUES (?)'
/** Existence probe only — never used to decide what to delete; this module deletes nothing. */
const SELECT_SESSION_ANY_ROW = 'SELECT 1 FROM journal_records WHERE session_id = ? LIMIT 1'

/** True when `sessionId` was already imported into this database (rows or marker alone). */
function markerPresent(db: JournalDatabase, sessionId: string): boolean {
  return db.prepare(SELECT_MARKER).get(sessionId) !== undefined
}

function writeMarker(db: JournalDatabase, sessionId: string): void {
  db.prepare(INSERT_MARKER).run(sessionId)
}

/**
 * True when `journal_records` already holds at least one row for `sessionId`,
 * independent of the marker. Rows-without-a-marker is the anomaly this module
 * refuses on (see the module doc) — this is the probe for it, checked both
 * before opening the file (the common case: a stale partial import from a
 * killed process) and again inside the first batch's transaction (the TOCTOU
 * case: another writer lands rows for this exact session between the outer
 * check and this transaction taking the write lock).
 */
function sessionHasRows(db: JournalDatabase, sessionId: string): boolean {
  return db.prepare(SELECT_SESSION_ANY_ROW).get(sessionId) !== undefined
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
 *
 * A file whose session already has rows but no marker is REFUSED, not wiped
 * (see the module doc): its id lands in `refusedSessions` and the loop moves
 * on to the next file — one refused file must never stop the rest of the
 * directory from importing.
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
    const refusedSessions: string[] = []
    for (const file of files) {
      if (markerPresent(handle.db, file.sessionId)) {
        continue // already migrated in an earlier run: not counted, not re-read
      }
      if (sessionHasRows(handle.db, file.sessionId)) {
        // The common trigger for this: a previous `migrate` was killed
        // partway through this file. Refuse rather than wipe — see the
        // module doc for why the row/marker state alone cannot tell that
        // apart from a still-running concurrent import.
        refusedSessions.push(file.sessionId)
        continue
      }
      const outcome = await importOneFile(handle, journalDir, file.sessionId)
      if (outcome.kind === 'already-migrated') {
        continue // a concurrent run owns this session (see `commitBatch`): reported as a skip
      }
      if (outcome.kind === 'refused') {
        refusedSessions.push(file.sessionId)
        continue
      }
      recordCount += outcome.recordCount
      sessionCount += 1
    }
    if (sessionCount === 0) {
      return { status: 'already-migrated', refusedSessions }
    }
    return { status: 'imported', recordCount, sessionCount, refusedSessions }
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
 *
 * A session refused by `migrateJournalFiles` (rows present, no marker) is
 * NOT distinguished from a fully-imported one here: `dbHasSession` answers
 * "yes" for both, since both already have rows a reader can serve. Any
 * operator-visible follow-up for a refused session comes from `migrate`'s own
 * stderr warning at the time of the refusal, not from this hint.
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
 * how the import settled: a running total once every batch commits, or the
 * first non-committing outcome a batch reports (see `commitBatch`). A
 * one-line lookahead after a full buffer decides whether the batch just
 * filled is also the file's last: without it, a file whose record count is
 * an exact multiple of the batch size would always split its final batch
 * from its marker into two transactions instead of (correctly, for the
 * exact-one-batch case) one.
 */
async function importOneFile(
  handle: SqliteHandle,
  journalDir: string,
  sessionId: string,
): Promise<ImportOutcome> {
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
      if (committed.kind !== 'imported') return committed
      return { kind: 'imported', recordCount: recordCount + committed.recordCount }
    }
    if (buffer.length < JOURNAL_BATCH_MAX_RECORDS) {
      continue
    }

    const lookahead = await lines.next()
    const isFinalBatch = lookahead.done === true
    const committed = commitBatch(handle, sessionId, buffer, isFirstBatch, isFinalBatch)
    if (committed.kind !== 'imported') return committed
    recordCount += committed.recordCount
    buffer = []
    isFirstBatch = false
    if (isFinalBatch) {
      return { kind: 'imported', recordCount }
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
 * One file's batch, inserted (never deleted — see the module doc) inside its
 * own transaction; the marker rides along with the LAST batch's insert, so a
 * process killed mid-file never leaves the marker without its rows.
 *
 * Both the marker AND the row-existence check are re-verified as the FIRST
 * statements of the FIRST batch's transaction, mirroring `insertLegacyChunk`
 * (`policy/approvals/queue-import.ts`) for the marker half. Without the
 * marker re-check, two concurrent `migrate` runs can both pass the outer
 * loop's check — which is outside any transaction — and both proceed to
 * insert, duplicating rows. Without the row-existence re-check, a writer that
 * lands rows for this exact session between the outer loop's `sessionHasRows`
 * probe and this transaction taking the write lock would have its rows
 * silently commingled with ours under the SAME "first batch" treatment the
 * outer check was meant to rule out — refusing here closes that window the
 * same way the outer check closes the common case. Neither re-check runs on
 * a later batch: by the time batch 2 starts, batch 1 already committed this
 * run's own rows for the session, so `sessionHasRows` would trivially be true
 * and is not a useful signal there.
 */
function commitBatch(
  handle: SqliteHandle,
  sessionId: string,
  rows: readonly JournalRecordRow[],
  isFirstBatch: boolean,
  isFinalBatch: boolean,
): ImportOutcome {
  return handle.transaction((db) => {
    if (markerPresent(db, sessionId)) {
      return { kind: 'already-migrated' }
    }
    if (isFirstBatch && sessionHasRows(db, sessionId)) {
      return { kind: 'refused' }
    }
    if (rows.length > 0) {
      insertRecordRows(db, rows)
    }
    if (isFinalBatch) {
      writeMarker(db, sessionId)
    }
    return { kind: 'imported', recordCount: rows.length }
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
