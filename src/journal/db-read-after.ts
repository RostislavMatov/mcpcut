import { JOURNAL_DIR } from '../config.js'
import { openJournalDbIfPresent } from './db.js'
import { numberOf, textOf } from './db-row.js'
import { parseJournalLine } from './line-source.js'
import type { JournalRecord } from './record.js'
import type { SqliteHandle } from '../store/sqlite.js'

/**
 * Cursor-side reads of `journal.db` for the Postgres index (ADR-0020 §6):
 * where the journal ends and how far it has been pruned. The SQL stays in the
 * journal layer; the front doors answer empty when there is no `journal.db`
 * and never create one.
 */

export interface JournalBounds {
  /** The newest record's `seq`, 0 for an empty journal. */
  readonly maxSeq: number
  /** The highest `pruned_through_seq` of any prune marker, 0 when never pruned. */
  readonly prunedThroughSeq: number
}

const EMPTY_BOUNDS: JournalBounds = { maxSeq: 0, prunedThroughSeq: 0 }

const SELECT_MAX_SEQ = 'SELECT MAX(seq) AS maxSeq FROM journal_records'
const SELECT_PRUNED_THROUGH = 'SELECT MAX(pruned_through_seq) AS prunedThroughSeq FROM journal_prune_marker'

export function dbJournalBounds(handle: SqliteHandle): JournalBounds {
  const max = handle.db.prepare(SELECT_MAX_SEQ).get()
  const pruned = handle.db.prepare(SELECT_PRUNED_THROUGH).get()
  return { maxSeq: numberOf(max?.['maxSeq'] ?? 0), prunedThroughSeq: numberOf(pruned?.['prunedThroughSeq'] ?? 0) }
}

/** The bounds of the journal in `dir`; a missing `journal.db` reads as empty. */
export async function journalBounds(dir: string = JOURNAL_DIR): Promise<JournalBounds> {
  return (await journalBoundsIfPresent(dir)) ?? EMPTY_BOUNDS
}

/** The bounds of the journal in `dir`, or null when there is no `journal.db` (nothing is created). */
export async function journalBoundsIfPresent(dir: string): Promise<JournalBounds | null> {
  const handle = await openJournalDbIfPresent(dir)
  return handle === null ? null : dbJournalBounds(handle)
}

const SELECT_RECORD_ID_AT = 'SELECT record_id AS recordId FROM journal_records WHERE seq = ?'

/** The `record_id` of the row at `seq`, null when no row has it (pruned, or a different journal). */
export function dbRecordIdAt(handle: SqliteHandle, seq: number): string | null {
  const row = handle.db.prepare(SELECT_RECORD_ID_AT).get(seq)
  return row === undefined ? null : textOf(row['recordId'])
}

/** `dbRecordIdAt` over the journal in `dir`; a missing `journal.db` has no rows. */
export async function journalRecordIdAt(dir: string, seq: number): Promise<string | null> {
  const handle = await openJournalDbIfPresent(dir)
  return handle === null ? null : dbRecordIdAt(handle, seq)
}

export interface RecordAfterSeq {
  readonly seq: number
  readonly sessionId: string
  readonly record: JournalRecord
}

export interface RecordsAfter {
  readonly rows: readonly RecordAfterSeq[]
  /** Every record up to this `seq` has been looked at: the cursor to resume from. */
  readonly throughSeq: number
  /** The `record_id` of the journal row at `throughSeq`; null when the cursor did not move. */
  readonly throughRecordId: string | null
}

const EMPTY_AFTER = (afterSeq: number): RecordsAfter => ({ rows: [], throughSeq: afterSeq, throughRecordId: null })

/** Calls and admin edits only: the file module reads nothing else. */
const SELECT_AFTER =
  "SELECT seq, session_id AS sessionId, doc FROM journal_records WHERE seq > ? AND seq <= ? AND kind IN ('decision', 'access-edit') ORDER BY seq LIMIT ?"

/**
 * At most `limit` decision / access-edit records after `afterSeq`, oldest
 * first. A row whose `doc` fails validation is skipped, never trusted. The
 * newest `seq` is read first and bounds the batch, so `throughSeq` never claims
 * a record written while the batch was being read.
 */
export function dbRecordsAfterSeq(handle: SqliteHandle, afterSeq: number, limit: number): RecordsAfter {
  const { maxSeq } = dbJournalBounds(handle)
  if (maxSeq <= afterSeq) return EMPTY_AFTER(afterSeq)
  const found = handle.db.prepare(SELECT_AFTER).all(afterSeq, maxSeq, limit)
  const rows = found.flatMap((row) => {
    const record = parseJournalLine(textOf(row['doc']))
    return record === null ? [] : [{ seq: numberOf(row['seq']), sessionId: textOf(row['sessionId']), record }]
  })
  const lastRead = found.length === limit ? numberOf(found[found.length - 1]?.['seq']) : maxSeq
  return { rows, throughSeq: lastRead, throughRecordId: dbRecordIdAt(handle, lastRead) }
}

/** `dbRecordsAfterSeq` over the journal in `dir`; a missing `journal.db` reads as empty. */
export async function journalRecordsAfter(dir: string, afterSeq: number, limit: number): Promise<RecordsAfter> {
  const handle = await openJournalDbIfPresent(dir)
  return handle === null ? EMPTY_AFTER(afterSeq) : dbRecordsAfterSeq(handle, afterSeq, limit)
}
