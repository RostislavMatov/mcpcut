import { TREE_ACTIONS, entryOfCall, entryOfEdit, type EditEntry, type FileAuditEntry } from '../audit-entry.js'
import { ACCESS_EDIT_SESSION_ID } from '../../journal/access-edit-record.js'
import { journalBounds, journalRecordsAfter, type RecordAfterSeq } from '../../journal/db-read-after.js'
import { lexicalKey, pathModuleOf } from '../names.js'
import type { FilesDb } from './connection.js'
import { INGEST_LOCK_KEY } from './constants.js'
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
  /** The journal `seq` the index has been filled through. */
  readonly lastSeq: number
  readonly journalMaxSeq: number
  readonly caughtUp: boolean
  /** Paths changed by allowed writes, moves and deletes of this ingest (for the catalog refresh). */
  readonly touched: readonly string[]
}

const DEFAULT_BATCH_SIZE = 1000
/** Tools that change the file system: the catalog re-stats what they named. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'create_directory', 'move_file', 'delete_file'])
const ALLOW_OUTCOME = 'allow'

interface EventRow {
  readonly journal_seq: number
  readonly record_id: string
  readonly session_id: string
  readonly ts: string
  readonly actor_kind: string
  readonly actor_name: string | null
  readonly actor_via: string | null
  readonly action: string
  readonly outcome: string | null
  readonly rule: string | null
  readonly subject_kind: string | null
  readonly subject_name: string | null
  readonly agent_key: string | null
  readonly paths: readonly string[]
}

interface PathRow {
  readonly journal_seq: number
  readonly ord: number
  readonly path_key: string
  readonly is_tree: boolean
}

interface Mapped {
  readonly event: EventRow
  readonly pathRows: readonly PathRow[]
}

interface BatchResult {
  readonly added: number
  readonly lastSeq: number
  readonly touched: readonly string[]
}

function mapRecord(row: RecordAfterSeq, platform: NodeJS.Platform): Mapped | undefined {
  const isEdit = row.sessionId === ACCESS_EDIT_SESSION_ID
  const mapped = isEdit ? entryOfEdit(row.record) : entryOfCall(row.sessionId, row.record)
  if (mapped === undefined) return undefined
  return { event: eventRowOf(row.seq, mapped, agentKeyOf(mapped)), pathRows: pathRowsOf(row.seq, mapped, platform) }
}

/** What `--agent` matches: the calling agent, or the agent an admin edit was for. */
function agentKeyOf(entry: FileAuditEntry | EditEntry): string | null {
  if ('agentOfEdit' in entry) return entry.agentOfEdit ?? null
  return entry.actor.kind === 'agent' ? entry.actor.name : null
}

function eventRowOf(seq: number, entry: FileAuditEntry, agentKey: string | null): EventRow {
  return {
    journal_seq: seq,
    record_id: entry.recordId,
    session_id: entry.sessionId,
    ts: entry.ts,
    actor_kind: entry.actor.kind,
    actor_name: entry.actor.name,
    actor_via: entry.actor.kind === 'admin' ? entry.actor.via : null,
    action: entry.action,
    outcome: entry.outcome,
    rule: entry.rule,
    subject_kind: entry.subject?.kind ?? null,
    subject_name: entry.subject?.name ?? null,
    agent_key: agentKey,
    paths: entry.paths,
  }
}

function pathRowsOf(seq: number, entry: FileAuditEntry, platform: NodeJS.Platform): readonly PathRow[] {
  const isAbsolute = pathModuleOf(platform).isAbsolute
  const isTree = TREE_ACTIONS.has(entry.action)
  return entry.paths.flatMap((value, ord) =>
    isAbsolute(value) ? [{ journal_seq: seq, ord, path_key: lexicalKey(value, platform), is_tree: isTree }] : [],
  )
}

function touchedOf(mapped: readonly Mapped[]): string[] {
  return mapped
    .filter(({ event }) => event.actor_kind === 'agent' && event.outcome === ALLOW_OUTCOME && MUTATING_TOOLS.has(event.action))
    .flatMap(({ event }) => [...event.paths])
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
  'INSERT INTO file_event_paths (journal_seq, ord, path_key, is_tree) ' +
  'SELECT x.journal_seq, x.ord, x.path_key, x.is_tree FROM jsonb_to_recordset($1::jsonb) AS x(journal_seq bigint, ord smallint, path_key text, is_tree boolean) ' +
  'ON CONFLICT DO NOTHING'

async function insertMapped(tx: PgQueryable, mapped: readonly Mapped[]): Promise<number> {
  if (mapped.length === 0) return 0
  const inserted = await tx.query(INSERT_EVENTS, [JSON.stringify(mapped.map((one) => one.event))])
  await tx.query(INSERT_PATHS, [JSON.stringify(mapped.flatMap((one) => one.pathRows))])
  return inserted.rowCount ?? 0
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
    const added = await insertMapped(tx, mapped)
    await tx.query('UPDATE ingest_state SET last_seq = $1, updated_at = now() WHERE id = 1', [after.throughSeq])
    return { added, lastSeq: after.throughSeq, touched: touchedOf(mapped) }
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
  let lastSeq = 0
  let touched: readonly string[] = []
  do {
    const batch = await runBatch(db, opts, batchSize)
    added += batch.added
    lastSeq = batch.lastSeq
    touched = [...touched, ...batch.touched]
  } while (lastSeq < maxSeq && now() - startedAt < opts.budgetMs)
  return { added, lastSeq, journalMaxSeq: maxSeq, caughtUp: lastSeq >= maxSeq, touched }
}
