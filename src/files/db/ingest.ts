import { journalBoundsIfPresent, journalRecordIdAt, journalRecordsAfter, type JournalBounds } from '../../journal/db-read-after.js'
import type { FilesDb } from './connection.js'
import { INGEST_LOCK_KEY } from './constants.js'
import { insertMapped } from './ingest-insert.js'
import { mapRecord, touchedOf } from './ingest-map.js'
import type { PgQueryable } from './pg-types.js'

/**
 * Journal → `file_events` (ADR-0020 §6). The journal stays the source of
 * truth; the index is derived and rebuildable. Each batch is one transaction
 * under an advisory lock, so two processes never both read the same cursor.
 */

export interface IngestOptions {
  readonly journalDir: string
  readonly platform: NodeJS.Platform
  /** Stop starting new batches once this much time is spent (at least one batch always runs). */
  readonly budgetMs: number
  readonly batchSize?: number
  readonly now?: () => number
}

export interface IngestResult {
  readonly added: number
  /** Records the database refused for what they hold: still in the journal, not in the index. */
  readonly skipped: number
  /** The journal `seq` the index has been filled through. */
  readonly lastSeq: number
  readonly journalMaxSeq: number
  readonly caughtUp: boolean
  /** Paths changed by allowed writes, moves and deletes of this ingest (for the catalog refresh). */
  readonly touched: readonly string[]
}

const DEFAULT_BATCH_SIZE = 1000

interface BatchResult {
  readonly added: number
  readonly skipped: number
  readonly lastSeq: number
  readonly touched: readonly string[]
}

interface CursorState {
  readonly lastSeq: number
  readonly lastRecordId: string | null
}

async function readState(tx: PgQueryable): Promise<CursorState> {
  const state = await tx.query<{ last_seq: string; last_record_id: string | null }>('SELECT last_seq, last_record_id FROM ingest_state WHERE id = 1')
  const row = state.rows[0]
  return { lastSeq: Number(row?.last_seq ?? 0), lastRecordId: row?.last_record_id ?? null }
}

async function runBatch(db: FilesDb, opts: IngestOptions, batchSize: number): Promise<BatchResult> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [INGEST_LOCK_KEY])
    const { lastSeq: cursor } = await readState(tx)
    const after = await journalRecordsAfter(opts.journalDir, cursor, batchSize)
    const mapped = after.rows.flatMap((row) => mapRecord(row, opts.platform) ?? [])
    const { added, skippedSeqs } = await insertMapped(tx, mapped)
    await tx.query(
      'UPDATE ingest_state SET last_seq = $1, last_record_id = COALESCE($2, last_record_id), ' +
        'skipped_seqs = skipped_seqs || $3::bigint[], updated_at = now() WHERE id = 1',
      [after.throughSeq, after.throughRecordId, skippedSeqs],
    )
    return { added, skipped: skippedSeqs.length, lastSeq: after.throughSeq, touched: touchedOf(mapped) }
  })
}

/**
 * Is the journal the cursor was taken in gone? Its newest seq is below the
 * cursor, or the row at the cursor is another record — unless that part has
 * been pruned and cannot be compared.
 */
async function isReplaced(state: CursorState, bounds: JournalBounds, journalDir: string): Promise<boolean> {
  if (bounds.maxSeq < state.lastSeq) return true
  if (state.lastSeq === 0 || state.lastSeq <= bounds.prunedThroughSeq) return false
  return (await journalRecordIdAt(journalDir, state.lastSeq)) !== state.lastRecordId
}

/** Rows and skipped records the journal no longer holds. */
async function forgetPruned(tx: PgQueryable, prunedThroughSeq: number): Promise<void> {
  await tx.query('DELETE FROM file_events WHERE journal_seq <= $1', [prunedThroughSeq])
  await tx.query('UPDATE ingest_state SET skipped_seqs = ARRAY(SELECT s FROM unnest(skipped_seqs) AS s WHERE s > $1) WHERE id = 1', [
    prunedThroughSeq,
  ])
}

/** How many records still in the journal the index refused; while any is, an audit reads the journal instead. */
export async function skippedRecordCount(db: FilesDb): Promise<number> {
  const result = await db.query<{ n: number | string }>('SELECT cardinality(skipped_seqs) AS n FROM ingest_state WHERE id = 1')
  return Number(result.rows[0]?.n ?? 0)
}

/** A replaced journal empties the index; a pruned one loses the rows it no longer holds. No `journal.db`: nothing is touched. */
async function reconcile(db: FilesDb, journalDir: string): Promise<{ maxSeq: number; present: boolean }> {
  const bounds = await journalBoundsIfPresent(journalDir)
  if (bounds === null) return { maxSeq: 0, present: false }
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [INGEST_LOCK_KEY])
    if (await isReplaced(await readState(tx), bounds, journalDir)) {
      await tx.query('DELETE FROM file_events')
      await tx.query("UPDATE ingest_state SET last_seq = 0, last_record_id = NULL, skipped_seqs = '{}', updated_at = now() WHERE id = 1")
    }
    if (bounds.prunedThroughSeq > 0) await forgetPruned(tx, bounds.prunedThroughSeq)
  })
  return { maxSeq: bounds.maxSeq, present: true }
}

export async function ingestJournal(db: FilesDb, opts: IngestOptions): Promise<IngestResult> {
  const now = opts.now ?? Date.now
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  const startedAt = now()
  const { maxSeq, present } = await reconcile(db, opts.journalDir)
  if (!present) {
    const { lastSeq: cursor } = await readState(db)
    return { added: 0, skipped: 0, lastSeq: cursor, journalMaxSeq: cursor, caughtUp: true, touched: [] }
  }
  let added = 0
  let skipped = 0
  let lastSeq = 0
  let touched: readonly string[] = []
  do {
    const batch = await runBatch(db, opts, batchSize)
    added += batch.added
    skipped += batch.skipped
    lastSeq = batch.lastSeq
    touched = [...touched, ...batch.touched]
  } while (lastSeq < maxSeq && now() - startedAt < opts.budgetMs)
  return { added, skipped, lastSeq, journalMaxSeq: maxSeq, caughtUp: lastSeq >= maxSeq, touched }
}
