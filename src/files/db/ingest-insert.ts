import { FilesDbError } from './errors.js'
import type { Mapped } from './ingest-map.js'
import type { PgQueryable } from './pg-types.js'

/**
 * Writing mapped records. The whole batch goes in one statement pair; when the
 * server rejects it for what the data is (SQLSTATE class 22 or 54), the batch
 * is redone record by record under savepoints and the ones that still fail are
 * skipped — they stay in the journal, only the index misses them. Connection
 * errors and anything else still throw.
 */

export interface InsertOutcome {
  readonly added: number
  /** Journal seqs of the records the database refused even one by one. */
  readonly skippedSeqs: readonly number[]
}

const INSERT_EVENTS =
  'INSERT INTO file_events (journal_seq, record_id, session_id, ts, actor_kind, actor_name, actor_via, action, outcome, rule, ' +
  'subject_kind, subject_name, agent_key, paths) ' +
  'SELECT x.journal_seq, x.record_id, x.session_id, x.ts, x.actor_kind, x.actor_name, x.actor_via, x.action, x.outcome, x.rule, ' +
  'x.subject_kind, x.subject_name, x.agent_key, ARRAY(SELECT jsonb_array_elements_text(x.paths)) ' +
  'FROM jsonb_to_recordset($1::jsonb) AS x(journal_seq bigint, record_id text, session_id text, ts text, actor_kind text, ' +
  'actor_name text, actor_via text, action text, outcome text, rule text, subject_kind text, subject_name text, agent_key text, paths jsonb) ' +
  'ON CONFLICT DO NOTHING'

const INSERT_PATHS =
  'INSERT INTO file_event_paths (journal_seq, ord, path_key, key_prefix, is_tree) ' +
  'SELECT x.journal_seq, x.ord, x.path_key, x.key_prefix, x.is_tree FROM jsonb_to_recordset($1::jsonb) ' +
  'AS x(journal_seq bigint, ord smallint, path_key text, key_prefix text, is_tree boolean) ON CONFLICT DO NOTHING'

const DATA_ERROR_CLASSES = ['22', '54']
const BATCH_SAVEPOINT = 'ingest_batch'
const RECORD_SAVEPOINT = 'ingest_record'

function isDataError(error: unknown): boolean {
  return error instanceof FilesDbError && error.sqlState !== undefined && DATA_ERROR_CLASSES.includes(error.sqlState.slice(0, 2))
}

async function insertAll(tx: PgQueryable, mapped: readonly Mapped[]): Promise<number> {
  const inserted = await tx.query(INSERT_EVENTS, [JSON.stringify(mapped.map((one) => one.event))])
  await tx.query(INSERT_PATHS, [JSON.stringify(mapped.flatMap((one) => one.pathRows))])
  return inserted.rowCount ?? 0
}

async function insertEach(tx: PgQueryable, mapped: readonly Mapped[]): Promise<InsertOutcome> {
  let added = 0
  const skippedSeqs: number[] = []
  for (const one of mapped) {
    await tx.query(`SAVEPOINT ${RECORD_SAVEPOINT}`)
    try {
      added += await insertAll(tx, [one])
      await tx.query(`RELEASE SAVEPOINT ${RECORD_SAVEPOINT}`)
    } catch (error: unknown) {
      if (!isDataError(error)) throw error
      await tx.query(`ROLLBACK TO SAVEPOINT ${RECORD_SAVEPOINT}`)
      skippedSeqs.push(one.event.journal_seq)
    }
  }
  return { added, skippedSeqs }
}

export async function insertMapped(tx: PgQueryable, mapped: readonly Mapped[]): Promise<InsertOutcome> {
  if (mapped.length === 0) return { added: 0, skippedSeqs: [] }
  await tx.query(`SAVEPOINT ${BATCH_SAVEPOINT}`)
  try {
    const added = await insertAll(tx, mapped)
    await tx.query(`RELEASE SAVEPOINT ${BATCH_SAVEPOINT}`)
    return { added, skippedSeqs: [] }
  } catch (error: unknown) {
    if (!isDataError(error)) throw error
    await tx.query(`ROLLBACK TO SAVEPOINT ${BATCH_SAVEPOINT}`)
    return insertEach(tx, mapped)
  }
}
