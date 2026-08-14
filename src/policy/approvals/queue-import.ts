import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
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
 * that still reads files at all. The legacy files are NEVER deleted — they stay
 * as a cold backup until wave 5 retires the file paths for good.
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
 */
export async function importLegacyApprovals(db: ApprovalsDb): Promise<number> {
  if (markerPresent(db.handle.db, APPROVALS_QUEUE_MARKER)) return 0

  // Resolved first: should an id somehow exist in both directories, the
  // settled record is the one that must win the `INSERT OR IGNORE`.
  const rows = [
    ...(await readLegacyDir(db.baseDir, RESOLVED_SUBDIR, true)),
    ...(await readLegacyDir(db.baseDir, PENDING_SUBDIR, false)),
  ]
  if (rows.length === 0) return 0 // nothing to import, and no marker to write

  // ULID file names: ascending order is chronological, so the change sequence
  // the rows get matches the order in which they were originally requested.
  const ordered = [...rows].sort((a, b) => (a.approvalId < b.approvalId ? -1 : 1))
  return runWriteTransaction(db, (database) => insertLegacyRows(database, ordered))
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
    return { status: 'already-migrated', pendingCount: 0, resolvedCount: 0 }
  }

  const [resolvedRows, pendingRows] = await Promise.all([
    readLegacyDir(baseDir, RESOLVED_SUBDIR, true),
    readLegacyDir(baseDir, PENDING_SUBDIR, false),
  ])
  if (resolvedRows.length === 0 && pendingRows.length === 0) {
    return { status: 'no-file', pendingCount: 0, resolvedCount: 0 }
  }

  // Triggers the lazy import as a side effect of opening the queue (marker-gated,
  // idempotent) — see the docstring above for why this module never imports directly.
  await openApprovalsDb(baseDir)

  return { status: 'imported', pendingCount: pendingRows.length, resolvedCount: resolvedRows.length }
}

function insertLegacyRows(database: StateDatabase, rows: readonly LegacyRow[]): number {
  // The race window: another process may have imported the same directories
  // between our marker read and this transaction taking the writer lock.
  if (markerPresent(database, APPROVALS_QUEUE_MARKER)) return 0

  let imported = 0
  for (const row of rows) {
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
  insertMigrationMarker(database, APPROVALS_QUEUE_MARKER)
  return imported
}

/** Every readable, well-formed record in one legacy directory; a missing directory yields none. */
async function readLegacyDir(
  baseDir: string,
  subdir: string,
  isResolved: boolean,
): Promise<LegacyRow[]> {
  const dir = join(baseDir, subdir)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return [] // no such directory (the common case): nothing to import
  }

  const rows: LegacyRow[] = []
  for (const name of names) {
    if (!name.endsWith(JSON_FILE_SUFFIX)) continue
    const row = await readLegacyFile(dir, name, isResolved)
    if (row !== null) rows.push(row) // malformed entries are skipped, never fatal
  }
  return rows
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
