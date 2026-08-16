import type { SqliteHandle } from '../store/sqlite.js'
import { iterateSessionDocs, type DbSessionSummary } from './db-read.js'
import { epochMsOf, numberOf, textOf } from './db-row.js'
import { parseJournalLine } from './line-source.js'
import type { JournalRecord } from './record.js'
import { matchesWithNeedle, type JournalFilters } from './search-filters.js'

/**
 * The session-scoped half of the journal's SQL read arm: the two questions
 * `reader.ts` and `index-cache.ts` ask that `db-read.ts` (paging and
 * cross-session walks, for `search.ts`) has no answer for. Same arm, same
 * rules — `doc` is re-validated on the way out and a row that fails is
 * counted and skipped, never trusted. It is a second module purely because
 * `db-read.ts` sits at the project's 400-line file ceiling.
 */

/**
 * One session's summary from the columns alone, or null when the database
 * holds no row for it — including the legitimate case of a session that has
 * only an import marker left. A single indexed `GROUP BY` over one session,
 * rather than the whole-database aggregate filtered down: an operator opening
 * one session must not pay for every other one.
 */
const SELECT_ONE_SESSION_AGGREGATE =
  'SELECT session_id AS sessionId, MIN(ts) AS firstTs, MAX(ts) AS lastTs, ' +
  'COUNT(*) AS recordCount, SUM(LENGTH(doc)) AS docLength ' +
  'FROM journal_records WHERE session_id = ? GROUP BY session_id'

const SELECT_ONE_SESSION_LAST_SEQ =
  'SELECT MAX(seq) AS lastSeq FROM journal_records WHERE session_id = ?'

/**
 * One session's freshness token, or null when it holds no rows —
 * `index-cache.ts`'s per-session probe, an indexed seek on
 * `idx_journal_session_seq` rather than the whole-database CTE
 * `dbSessionLastSeqs` runs for the list view.
 */
export function dbSessionLastSeqFor(handle: SqliteHandle, sessionId: string): number | null {
  const row = handle.db.prepare(SELECT_ONE_SESSION_LAST_SEQ).get(sessionId)
  const raw = row?.['lastSeq']
  return raw === null || raw === undefined ? null : numberOf(raw)
}

export function dbSessionSummaryFor(
  handle: SqliteHandle,
  sessionId: string,
): DbSessionSummary | null {
  const row = handle.db.prepare(SELECT_ONE_SESSION_AGGREGATE).get(sessionId)
  if (row === undefined) {
    return null
  }
  const lastTs = textOf(row['lastTs'])
  return {
    sessionId: textOf(row['sessionId']),
    firstTs: textOf(row['firstTs']),
    lastTs,
    count: numberOf(row['recordCount']),
    // See `DbSessionSummary`: an aggregate never parses a `doc`, so it cannot
    // know how many rows a reader would have to skip.
    skippedLineCount: 0,
    size: numberOf(row['docLength']),
    mtimeMs: epochMsOf(lastTs),
  }
}

/** Every record of one session, plus the rows that were not readable as one. */
export interface DbSessionRecords {
  readonly records: readonly JournalRecord[]
  readonly skippedLineCount: number
}

/**
 * A whole session's matching records, in `seq` order — the CLI's one-shot
 * print, which has no paging and must therefore have no cap either. It
 * deliberately does NOT go through `dbSearchSession`: that clamps to
 * `MAX_PAGE_LIMIT`, and silently returning the first thousand records of a
 * session an operator asked to see whole is the kind of quiet truncation an
 * audit product cannot afford.
 *
 * Rows stream one at a time, so the cost of getting here is bounded even
 * though the answer is not; the caller materializes what it asked for.
 */
export function dbReadSessionRecords(
  handle: SqliteHandle,
  sessionId: string,
  filters: JournalFilters,
): DbSessionRecords {
  const records: JournalRecord[] = []
  let skippedLineCount = 0

  for (const doc of iterateSessionDocs(handle, sessionId)) {
    const record = parseJournalLine(doc)
    if (record === null) {
      // A `doc` is NOT NULL and always written as a serialized record, so
      // unlike a file line this is never a blank to be ignored: it is a
      // malformed row, and the count is what tells the operator so.
      skippedLineCount += 1
      continue
    }
    // No text needle: this entry point exposes only the method/direction/kind
    // filters, and `matchesWithNeedle` is reused rather than reimplemented so
    // the two carriers cannot drift on what "matches" means.
    if (matchesWithNeedle(record, filters, undefined)) {
      records.push(record)
    }
  }

  return { records, skippedLineCount }
}
