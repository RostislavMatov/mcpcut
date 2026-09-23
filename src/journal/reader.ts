import { JOURNAL_DIR } from '../config.js'
import { openJournalDbIfPresent } from './db.js'
import { dbHasSession, dbSessionSummaries, type DbSessionSummary } from './db-read.js'
import { dbReadSessionRecords } from './db-read-session.js'
import type { JournalDirection, JournalRecord } from './record.js'
import { assertValidSessionId } from './session-id.js'

/** Directions a journal record can carry; exported so callers (e.g. the CLI) can validate untrusted input against it. */
export const JOURNAL_DIRECTIONS: readonly JournalDirection[] = [
  'client→server',
  'server→client',
  'server-stderr',
]

/** Kinds a journal record can carry; exported so callers (e.g. the CLI) can validate untrusted input against it. */
export const JOURNAL_KINDS: readonly string[] = [
  'request',
  'response',
  'notification',
  'invalid',
  'stderr',
  'decision',
  'probe',
  'policy-edit',
  'access-edit',
  'pool',
]

export interface SessionSummary {
  readonly sessionId: string
  readonly firstTs: string
  readonly lastTs: string
  readonly messageCount: number
  /** Lines that were not readable as journal records and were skipped. */
  readonly skippedLineCount: number
}

export interface ReadSessionOptions {
  readonly dir?: string
  readonly method?: string
  readonly direction?: JournalDirection
  readonly kind?: string
}

/** Records matching the filters, plus how many lines had to be skipped. */
export interface SessionReadResult {
  readonly records: readonly JournalRecord[]
  readonly skippedLineCount: number
}

/**
 * Lists every session `journal.db` holds, newest activity first. A directory
 * with no database yields an empty list rather than throwing — and is not
 * given one, because a read must never create it.
 *
 * Legacy `*.jsonl` files are NOT listed (M4.5 wave 5): `journal.db` is the one
 * carrier of journal truth, and an un-imported file becomes visible only after
 * `mcpcut migrate`. A database session with no rows left — an import
 * marker alone — is omitted because there is nothing to show.
 */
export async function listSessions(dir: string = JOURNAL_DIR): Promise<SessionSummary[]> {
  const handle = await openJournalDbIfPresent(dir)
  if (handle === null) {
    return []
  }
  return dbSessionSummaries(handle)
    .map(toSessionSummary)
    .sort((a, b) => b.lastTs.localeCompare(a.lastTs))
}

/** The database's summary in the shape this module's callers already print. */
function toSessionSummary(summary: DbSessionSummary): SessionSummary {
  return {
    sessionId: summary.sessionId,
    firstTs: summary.firstTs,
    lastTs: summary.lastTs,
    messageCount: summary.count,
    skippedLineCount: summary.skippedLineCount,
  }
}

/** True when `value` is one of the journal's recognized traffic directions. */
export function isValidJournalDirection(value: string): value is JournalDirection {
  return (JOURNAL_DIRECTIONS as readonly string[]).includes(value)
}

/** True when `value` is one of the journal's recognized record kinds. */
export function isValidJournalKind(value: string): boolean {
  return JOURNAL_KINDS.includes(value)
}

/**
 * Reads one session's records, optionally filtered by method and/or
 * direction. A session the database does not hold yields an empty array.
 * Throws if `sessionId` is not a safe file name.
 */
export async function readSession(
  sessionId: string,
  options: ReadSessionOptions = {},
): Promise<JournalRecord[]> {
  const { records } = await readSessionWithStats(sessionId, options)
  return [...records]
}

/**
 * Same as `readSession`, but also reports how many lines were skipped.
 *
 * The session is read from `journal.db` whole and uncapped — this is the
 * one-shot print, so a page limit would be silent truncation. A session the
 * database is not the carrier for reads as empty; `mcpcut migrate` is
 * what makes a legacy `*.jsonl` one of its own.
 */
export async function readSessionWithStats(
  sessionId: string,
  options: ReadSessionOptions = {},
): Promise<SessionReadResult> {
  assertValidSessionId(sessionId)
  const dir = options.dir ?? JOURNAL_DIR
  const handle = await openJournalDbIfPresent(dir)
  if (handle === null || !dbHasSession(handle, sessionId)) {
    return { records: [], skippedLineCount: 0 }
  }
  return dbReadSessionRecords(handle, sessionId, options)
}
