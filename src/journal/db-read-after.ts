import { JOURNAL_DIR } from '../config.js'
import { openJournalDbIfPresent } from './db.js'
import { numberOf } from './db-row.js'
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
  const handle = await openJournalDbIfPresent(dir)
  return handle === null ? EMPTY_BOUNDS : dbJournalBounds(handle)
}
