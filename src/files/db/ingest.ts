import { journalBounds, journalRecordsAfter } from '../../journal/db-read-after.js'
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

async function readCursor(tx: PgQueryable): Promise<number> {
  const state = await tx.query<{ last_seq: string }>('SELECT last_seq FROM ingest_state WHERE id = 1')
  return Number(state.rows[0]?.last_seq ?? 0)
}

async function runBatch(db: FilesDb, opts: IngestOptions, batchSize: number): Promise<BatchResult> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [INGEST_LOCK_KEY])
    const cursor = await readCursor(tx)
    const after = await journalRecordsAfter(opts.journalDir, cursor, batchSize)
    const mapped = after.rows.flatMap((row) => mapRecord(row, opts.platform) ?? [])
    const { added, skipped } = await insertMapped(tx, mapped)
    await tx.query('UPDATE ingest_state SET last_seq = $1, updated_at = now() WHERE id = 1', [after.throughSeq])
    return { added, skipped, lastSeq: after.throughSeq, touched: touchedOf(mapped) }
  })
}

/** A replaced journal (newest seq below the cursor) empties the index; a pruned one loses the rows it no longer holds. */
async function reconcile(db: FilesDb, journalDir: string): Promise<{ maxSeq: number }> {
  const bounds = await journalBounds(journalDir)
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [INGEST_LOCK_KEY])
    if (bounds.maxSeq < (await readCursor(tx))) {
      await tx.query('DELETE FROM file_events')
      await tx.query('UPDATE ingest_state SET last_seq = 0, updated_at = now() WHERE id = 1')
    }
    if (bounds.prunedThroughSeq > 0) await tx.query('DELETE FROM file_events WHERE journal_seq <= $1', [bounds.prunedThroughSeq])
  })
  return { maxSeq: bounds.maxSeq }
}

export async function ingestJournal(db: FilesDb, opts: IngestOptions): Promise<IngestResult> {
  const now = opts.now ?? Date.now
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  const startedAt = now()
  const { maxSeq } = await reconcile(db, opts.journalDir)
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
