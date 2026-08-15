import { existsSync } from 'node:fs'
import { journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'
import { textOf } from '../../src/journal/db-row.js'
import type { JournalRecord } from '../../src/journal/record.js'

/**
 * The ONE place tests read journal content back since the sink moved from
 * per-session `<sessionId>.jsonl` files to rows in `journal.db` (M4.5 wave
 * 4). Every suite that used to parse `.jsonl` files reads through this
 * module instead, so the next carrier change lands once instead of leaving
 * diverged copies of the same SELECT.
 */

/**
 * The records written for `sessionId` (or every record in the journal
 * directory, in commit order, when `sessionId` is omitted), parsed from
 * `journal.db`'s `doc` column. Returns `[]` when the database file does not
 * exist yet — a session that journaled nothing never creates it — so callers
 * that used to guard with `existsSync('<sessionId>.jsonl')` can drop the
 * guard.
 */
export async function readJournalRecords(
  journalDir: string,
  sessionId?: string,
): Promise<JournalRecord[]> {
  const dbPath = journalDbPathFor(journalDir)
  if (!existsSync(dbPath)) return []

  const handle = await openJournalDbShared(dbPath)
  // Columns are narrowed with the read arm's own helper rather than asserted
  // with a cast: a row `node:sqlite` hands back is `unknown`-valued, and a
  // lying cast is exactly what a test support module must not introduce.
  const rows =
    sessionId === undefined
      ? handle.db.prepare('SELECT doc FROM journal_records ORDER BY seq').all()
      : handle.db
          .prepare('SELECT doc FROM journal_records WHERE session_id = ? ORDER BY seq')
          .all(sessionId)
  return rows.map((row) => JSON.parse(textOf(row['doc'])) as JournalRecord)
}

/**
 * Every distinct session id that has written at least one row into
 * `journalDir`'s `journal.db`, in the order each first appeared. Replaces
 * the old pattern of listing `*.jsonl` files to discover which sessions
 * exist. Returns `[]` when the database file does not exist yet.
 */
export async function journalSessionIds(journalDir: string): Promise<string[]> {
  const dbPath = journalDbPathFor(journalDir)
  if (!existsSync(dbPath)) return []

  const handle = await openJournalDbShared(dbPath)
  const rows = handle.db
    .prepare('SELECT session_id AS sessionId FROM journal_records GROUP BY session_id ORDER BY MIN(seq)')
    .all()
  return rows.map((row) => textOf(row['sessionId']))
}
