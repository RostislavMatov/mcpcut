import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { APPROVALS_IMPORT_BATCH_ROWS } from '../../config.js'
import {
  insertMigrationMarker,
  markerPresent,
  openStateDbShared,
  rethrowClassified,
  type StateDatabase,
} from '../store-backend.js'
import {
  approvalsDbPath,
  bumpChangeSeq,
  openApprovalsDb,
  runWriteTransaction,
  type ApprovalsDb,
} from './queue-db.js'
import {
  isPendingApprovalFile,
  isResolvedApprovalFile,
  parseDoc,
  type PendingApprovalFile,
  type ResolvedApprovalFile,
} from './queue-file.js'

/**
 * Lazy import of the file-based approvals queue an M4 build left on disk
 * (`<baseDir>/pending/*.json`, `<baseDir>/resolved/*.json`) into the
 * `approvals` table. Called by `openApprovalsDb` on first touch of a process,
 * from whichever entry path gets there first (the queue itself or the gate's
 * grant check), so an upgraded installation keeps its open requests and its
 * recent approvals without the operator running anything.
 *
 * Split from `queue-db.ts` for the <400-line file rule, the same way
 * `queue-file.ts` is split from `queue.ts`; it is the only part of the queue
 * that still reads files at all. The legacy files are NEVER deleted — they
 * stay as a cold backup indefinitely. (Wave 5 retired the JOURNAL's file-read
 * arm — `search.ts`/`reader.ts` no longer walk `*.jsonl` — but that is a
 * different subsystem's read path; this queue's lazy file import is a
 * separate mechanism, unaffected, and stays lazy.)
 */

const PENDING_SUBDIR = 'pending'
const RESOLVED_SUBDIR = 'resolved'
const JSON_FILE_SUFFIX = '.json'

/**
 * The import marker, a row in the `migrated_documents` table the document
 * stores already use (one atomic marker mechanism, not two). Document markers
 * are file BASENAMES, all of which end in `.json`, so this name cannot collide
 * with one.
 */
export const APPROVALS_QUEUE_MARKER = 'approvals-queue'

const INSERT_LEGACY_ROW =
  'INSERT OR IGNORE INTO approvals (approval_id, status, doc, server_name, tool_name, ' +
  'args_hash, requested_at, expires_at, outcome, resolved_at, change_seq) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

/** One legacy file, ready to become a row; `doc` is the file's text, unaltered. */
interface LegacyRow {
  readonly approvalId: string
  readonly status: 'pending' | 'resolved'
  readonly doc: string
  readonly serverName: string
  readonly toolName: string
  readonly argsHash: string
  readonly requestedAt: string
  readonly expiresAt: string
  readonly outcome: string | null
  readonly resolvedAt: string | null
}

/**
 * Imports whatever legacy files are present, once, and returns how many rows
 * were created. Idempotent by the marker, and safe to run concurrently with
 * another process doing the same: the marker is re-checked INSIDE the write
 * transaction, and the inserts are `INSERT OR IGNORE` on the approval id.
 *
 * Unlike the document stores, this does NOT call `assertNotPreviouslyMigrated`
 * — "marker present, table empty" is not evidence of data loss here:
 *
 * - retention deletes settled rows as a matter of course, so an empty table is
 *   the NORMAL end state of an imported queue;
 * - re-importing cannot resurrect a settled request anyway: `resolve()` changes
 *   a row's status instead of deleting it, so importing the same id twice is a
 *   no-op while the row exists;
 * - the only value a re-import could revive is a grant, and that is bounded by
 *   the grant TTL window (minutes), not by the life of the installation.
 *
 * Refusing loudly would therefore break ordinary operation of a healthy queue,
 * which is the opposite of what the document-store rule protects.
 *
 * The rows are inserted in chunks of `APPROVALS_IMPORT_BATCH_ROWS`, each its
 * own write transaction, rather than one transaction for an arbitrarily large
 * backlog: a years-old installation's `pending`/`resolved` directories can
 * hold thousands of files, and a single synchronous transaction over all of
 * them would hold the writer lock — and block the event loop — for the whole
 * import. Only the LAST chunk writes the marker, so a crash between chunks
 * leaves no marker at all; the rerun this implies is safe for the same reason
 * a concurrent second pass is (see above): every insert is `INSERT OR IGNORE`
 * on the approval id, so replaying already-imported chunks is a no-op, and
 * the marker check inside each chunk's transaction stops the rerun the moment
 * it reaches rows a completed run already covered.
 */
export async function importLegacyApprovals(db: ApprovalsDb): Promise<number> {
  if (markerPresent(db.handle.db, APPROVALS_QUEUE_MARKER)) return 0

  const { rows: ordered } = await scanLegacyDirs(db.baseDir)
  if (ordered.length === 0) return 0 // nothing to import, and no marker to write

  let imported = 0
  for (let start = 0; start < ordered.length; start += APPROVALS_IMPORT_BATCH_ROWS) {
    const chunk = ordered.slice(start, start + APPROVALS_IMPORT_BATCH_ROWS)
    const isLast = start + chunk.length >= ordered.length
    const chunkImported = await runWriteTransaction(db, (database) =>
      insertLegacyChunk(database, chunk, isLast),
    )
    // null = another process's import finished and wrote the marker between
    // our chunks; stop here rather than re-inserting rows it already covered.
    if (chunkImported === null) break
    imported += chunkImported
    if (!isLast) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return imported
}

/** Status set `mcp-journal migrate` reports for the approvals queue (its own, not the four
 * document stores' `LegacyMigrationStatus`): the queue has no `native` case worth
 * distinguishing here — a queue created by ordinary use, with no legacy files ever seen,
 * reports the same `no-file` a fresh install would. */
export type ApprovalsMigrationStatus = 'imported' | 'already-migrated' | 'no-file'

/** Report `migrateApprovalsQueue` hands back to the CLI: status plus, for `imported`,
 * how many legacy records of each kind were found and brought in. */
export interface ApprovalsMigrationResult {
  readonly status: ApprovalsMigrationStatus
  readonly pendingCount: number
  readonly resolvedCount: number
  /**
   * `resolved/*.json` files found but NOT readable back as a settled record
   * (truncated by a crash or a bad `cp`, hand-edited, missing
   * `resolution.outcome`, carrying somebody else's `approvalId`). Reported
   * beside the good counts the way the journal's per-session `Unreadable`
   * column is, never swallowed; `scanLegacyDirs` covers what the id becomes.
   */
  readonly unreadableSettledCount: number
}

/**
 * The explicit-command counterpart of `importLegacyApprovals`'s lazy import, used by
 * `mcp-journal migrate` (`src/cli/migrate-cmd.ts`) to report on the approvals queue up
 * front, mirroring `migrateLegacyStateFile` (`store-migrate.ts`) for the document stores.
 *
 * `journalDir`, not `baseDir`: every production caller derives the queue's directory the
 * same way (`join(journalDir, 'approvals')`), and taking the journal directory here keeps
 * this probe's signature symmetric with `migrateLegacyStateFile`'s file-path argument.
 *
 * This never writes on its own: opening the queue (`openApprovalsDb`) is what performs the
 * import, through the exact lazy path any other consumer would trigger on first touch — so
 * `migrate` can never persist a shape the ordinary path would refuse. The legacy directories
 * are read once, ahead of that call, purely to report how many well-formed records were
 * found; a race with another process importing between the two reads would double-count in
 * the report only, never in the database, which stays marker-gated exactly like `queue-db.ts`.
 */
export async function migrateApprovalsQueue(journalDir: string): Promise<ApprovalsMigrationResult> {
  const baseDir = join(journalDir, 'approvals')
  const dbPath = approvalsDbPath(baseDir)

  let db: StateDatabase
  try {
    db = (await openStateDbShared(dbPath)).db
  } catch (error: unknown) {
    rethrowClassified(dbPath, error, true)
  }

  if (markerPresent(db, APPROVALS_QUEUE_MARKER)) {
    return {
      status: 'already-migrated',
      pendingCount: 0,
      resolvedCount: 0,
      unreadableSettledCount: 0,
    }
  }

  // The SAME scan the import itself runs, not a second reading of the directories:
  // the counts are then what the database will hold by construction, instead of a
  // re-derivation of the import's dedup rules that can drift away from them.
  const scan = await scanLegacyDirs(baseDir)
  const { pendingCount, resolvedCount, unreadableSettledCount } = scan
  // No importable record — but an unreadable settled file is still reported, so
  // "nothing to migrate" can never quietly mean "a settled record was lost".
  if (scan.rows.length === 0) {
    return { status: 'no-file', pendingCount: 0, resolvedCount: 0, unreadableSettledCount }
  }

  // Triggers the lazy import as a side effect of opening the queue (marker-gated,
  // idempotent) — see the docstring above for why this module never imports directly.
  await openApprovalsDb(baseDir)

  return { status: 'imported', pendingCount, resolvedCount, unreadableSettledCount }
}

/**
 * Inserts one chunk's rows inside its own write transaction. Returns `null`
 * instead of a count when the marker is already present: the race window is
 * the same one `insertLegacyRows` (pre-chunking) guarded against — another
 * process may have imported the same directories between our marker read and
 * this transaction taking the writer lock — but re-checked on EVERY chunk
 * now, since the gap between chunks (`setImmediate`) is a second such window.
 * Only `isLast` writes the marker, so a chunk that is not the last one never
 * claims an import this call has not actually finished yet.
 */
function insertLegacyChunk(
  database: StateDatabase,
  chunk: readonly LegacyRow[],
  isLast: boolean,
): number | null {
  if (markerPresent(database, APPROVALS_QUEUE_MARKER)) return null

  let imported = 0
  for (const row of chunk) {
    const result = database
      .prepare(INSERT_LEGACY_ROW)
      .run(
        row.approvalId,
        row.status,
        row.doc,
        row.serverName,
        row.toolName,
        row.argsHash,
        row.requestedAt,
        row.expiresAt,
        row.outcome,
        row.resolvedAt,
        bumpChangeSeq(database),
      )
    imported += Number(result.changes)
  }
  if (isLast) insertMigrationMarker(database, APPROVALS_QUEUE_MARKER)
  return imported
}

/** One legacy directory as read: the usable rows, plus the file basenames (the
 * record identity in that layout) whose content failed to parse or validate. */
interface LegacyDirScan {
  readonly rows: readonly LegacyRow[]
  readonly unreadableIds: readonly string[]
}

/** Both directories reconciled: one row per approval id, ascending by id, ready to insert. */
interface LegacyScan {
  readonly rows: readonly LegacyRow[]
  readonly pendingCount: number
  readonly resolvedCount: number
  readonly unreadableSettledCount: number
}

/**
 * Reads both legacy directories and reconciles them into ONE row per approval
 * id, decided here rather than left to `INSERT OR IGNORE`. The single source of
 * the import's row set AND of `migrate`'s counts, so the two cannot drift.
 *
 * The one-outcome-per-id invariant must NOT depend on sort stability or on the
 * order the two directories were concatenated in. Both held before this change,
 * but only incidentally: ECMA-262 leaves the order an inconsistent comparator
 * produces implementation-defined, so "the settled copy stays ahead of its
 * pending twin" rested on a V8 detail. A Map keyed by the id, settled records
 * inserted first, makes it structural — a pending twin is never even a
 * candidate row, whatever any sort does afterwards.
 *
 * FAIL-CLOSED on an unreadable settled record. `resolved/<id>.json` that cannot
 * be parsed used to be dropped silently, which let the `pending/<id>.json` twin
 * import as an OPEN request — a settled decision resurrected as approvable, on
 * exactly the route (`cp -p` of the legacy directories, M4.5 README) where a
 * truncated file is most likely. Such an id is claimed BEFORE any pending row
 * can take it: with a twin it becomes an inert settled row, without one it is
 * only counted (see `inertRowFor`).
 */
async function scanLegacyDirs(baseDir: string): Promise<LegacyScan> {
  const [resolved, pending] = await Promise.all([
    readLegacyDir(baseDir, RESOLVED_SUBDIR, true),
    readLegacyDir(baseDir, PENDING_SUBDIR, false),
  ])

  const byId = new Map<string, LegacyRow>()
  for (const row of resolved.rows) if (!byId.has(row.approvalId)) byId.set(row.approvalId, row)

  const pendingById = new Map(pending.rows.map((row) => [row.approvalId, row] as const))
  let unreadableSettledCount = 0
  for (const id of resolved.unreadableIds) {
    if (byId.has(id)) continue // a readable settled record already owns this id
    unreadableSettledCount += 1
    const inert = inertRowFor(pendingById.get(id))
    if (inert !== null) byId.set(id, inert)
  }

  for (const row of pending.rows) if (!byId.has(row.approvalId)) byId.set(row.approvalId, row)

  // ULID ids: ascending order is chronological, so the change sequence the rows
  // get matches the order in which they were originally requested. TOTAL
  // comparator (0 on equality): ids are unique Map keys so a tie cannot arise,
  // and a fake ordering is exactly what the invariant must not lean on again.
  const rows = [...byId.values()].sort((a, b) => {
    if (a.approvalId === b.approvalId) return 0
    return a.approvalId < b.approvalId ? -1 : 1
  })

  return {
    rows,
    pendingCount: rows.filter((row) => row.status === 'pending').length,
    resolvedCount: rows.filter((row) => row.status === 'resolved').length,
    unreadableSettledCount,
  }
}

/** The outcome an inert row carries: `markExpired()`'s, for a decision no operator made. */
const UNREADABLE_SETTLED_OUTCOME = 'expired'
const UNREADABLE_SETTLED_REASON = 'legacy settled record was unreadable at import'

/**
 * Turns the readable pending twin of an unreadable settled record into a settled
 * and INERT row: `expired`, so nothing can approve it and `checkRecentApproval`
 * can never mint a grant from it, yet still a record `listResolved()` shows —
 * chosen over refusing the id outright because a silently absent row tells
 * nobody a decision was lost, while this one names the request and its tool.
 *
 * `null` when there is no twin: nothing readable exists for that id anywhere, so
 * there is no request to make inert and no honest record to synthesize from
 * invented fields. That id is a LOST record — reported through
 * `unreadableSettledCount`, and never approvable, since nothing inserts it.
 */
function inertRowFor(twin: LegacyRow | undefined): LegacyRow | null {
  if (twin === undefined) return null
  const record = parseDoc(twin.doc, isPendingApprovalFile)
  if (record === null) return null // unreachable: `readLegacyFile` already validated it

  const resolvedAt = new Date().toISOString()
  const doc: ResolvedApprovalFile = {
    ...record,
    resolution: { outcome: UNREADABLE_SETTLED_OUTCOME, reason: UNREADABLE_SETTLED_REASON },
    resolvedAt,
  }
  return {
    ...twin,
    status: 'resolved',
    doc: JSON.stringify(doc),
    outcome: UNREADABLE_SETTLED_OUTCOME,
    resolvedAt,
  }
}

/** Every readable, well-formed record in one legacy directory; a missing directory yields none. */
async function readLegacyDir(
  baseDir: string,
  subdir: string,
  isResolved: boolean,
): Promise<LegacyDirScan> {
  const dir = join(baseDir, subdir)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return { rows: [], unreadableIds: [] } // no such directory (the common case)
  }

  const rows: LegacyRow[] = []
  const unreadableIds: string[] = []
  for (const name of names) {
    if (!name.endsWith(JSON_FILE_SUFFIX)) continue
    const row = await readLegacyFile(dir, name, isResolved)
    // Malformed entries are never fatal — but they are no longer invisible
    // either: the file name IS the record's identity here, so it is reported
    // (and, for `resolved/`, claimed) under that id.
    if (row === null) unreadableIds.push(basename(name, JSON_FILE_SUFFIX))
    else rows.push(row)
  }
  return { rows, unreadableIds }
}

async function readLegacyFile(
  dir: string,
  name: string,
  isResolved: boolean,
): Promise<LegacyRow | null> {
  let text: string
  let raw: unknown
  try {
    text = await readFile(join(dir, name), 'utf8')
    raw = JSON.parse(text)
  } catch {
    return null // unreadable or not JSON: skip, exactly as the file queue did
  }
  if (!(isResolved ? isResolvedApprovalFile(raw) : isPendingApprovalFile(raw))) return null

  const record = raw as PendingApprovalFile | ResolvedApprovalFile
  // The file name IS the record's identity in the legacy layout, so a file
  // carrying somebody else's approvalId was moved or forged. This is the last
  // point at which file names exist — after the import the primary key is the
  // identity — so the binding is checked here or nowhere.
  if (record.approvalId !== basename(name, JSON_FILE_SUFFIX)) return null

  const resolved = isResolved ? (record as ResolvedApprovalFile) : null
  return {
    approvalId: record.approvalId,
    status: resolved === null ? 'pending' : 'resolved',
    doc: text,
    serverName: record.serverName,
    toolName: record.toolName,
    argsHash: record.argsHash,
    requestedAt: record.requestedAt,
    expiresAt: record.expiresAt,
    outcome: resolved?.resolution.outcome ?? null,
    resolvedAt: resolved?.resolvedAt ?? null,
  }
}
