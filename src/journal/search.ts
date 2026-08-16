import { JOURNAL_DIR } from '../config.js'
import { openJournalDbIfPresent } from './db.js'
import { dbHasSession, dbSearchAllSessions, dbSearchSession } from './db-read.js'
import type { JournalRecord } from './record.js'
import type { JournalFilters } from './search-filters.js'
import { DEFAULT_PAGE_LIMIT, normalizeLimit, normalizeOffset } from './search-limits.js'
import { assertValidSessionId } from './session-id.js'

/**
 * Read side of the journal for interactive callers (the admin UI): paged,
 * filtered, streaming access to `journal.db`'s rows with a hard cost ceiling
 * at every level. `reader.ts` stays as it is — it materializes a whole
 * session, which is right for a one-shot CLI print and wrong for a page an
 * operator refreshes.
 *
 * Two rules hold throughout:
 * - nothing is read that the caller did not ask for. A page stops as soon as
 *   it is full and one further match has been seen, so cost follows
 *   `offset + limit`, not session size;
 * - every walk is bounded by named limits, and a walk that hit one says so
 *   (`truncated`, `stoppedBy`, `filesScanned` of `filesTotal`). Silently
 *   partial output is worse than a refusal in an audit product.
 *
 * The SQL that answers all of this is in `db-read.ts`; this module is the
 * front door that resolves the journal directory's database and hands over.
 * A directory with no `journal.db` answers empty rather than throwing, and is
 * never given one — a read must not create the carrier (M4.5 wave 5).
 */

/** Re-exported so a caller keeps getting the ceilings from the read layer's front door (impl: `search-limits.ts`). */
export {
  CROSS_SESSION_DEFAULT_LIMIT,
  CROSS_SESSION_MAX_BYTES,
  CROSS_SESSION_MAX_FILES,
  CROSS_SESSION_TIME_BUDGET_MS,
  DEADLINE_CHECK_LINE_INTERVAL,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MAX_SCANNED_LINES_PER_SESSION,
} from './search-limits.js'

/** Re-exported so filter callers keep one import surface (impl: `search-filters.ts`). */
export { matchesFilters, type JournalFilters } from './search-filters.js'

export interface SessionPageOptions extends JournalFilters {
  readonly dir?: string
  readonly offset?: number
  readonly limit?: number
  readonly maxScannedLines?: number
}

export interface SessionPage {
  readonly records: readonly JournalRecord[]
  readonly offset: number
  readonly limit: number
  readonly scannedLineCount: number
  readonly skippedLineCount: number
  /** True when at least one more record matches beyond this page. */
  readonly hasMore: boolean
  /** True when the scan cap was reached, so the page may be incomplete. */
  readonly truncated: boolean
}

/** Why a cross-session walk stopped early. */
export type ScanStopReason = 'files' | 'bytes' | 'deadline' | 'limit'

export interface CrossSessionHit {
  readonly sessionId: string
  readonly record: JournalRecord
}

export interface CrossSessionSearchOptions extends JournalFilters {
  readonly dir?: string
  readonly limit?: number
  readonly maxFiles?: number
  readonly maxBytes?: number
  readonly timeBudgetMs?: number
}

export interface CrossSessionSearchResult {
  readonly hits: readonly CrossSessionHit[]
  readonly truncated: boolean
  readonly stoppedBy: ScanStopReason | null
  readonly filesScanned: number
  readonly filesTotal: number
  readonly bytesRead: number
  readonly skippedLineCount: number
}

/**
 * Reads one page of a session's records. Reading stops as soon as the page is
 * full and one further match has been seen (that match is the `hasMore`
 * answer and is not kept). A session the database does not hold — including
 * every session of a directory with no database — yields an empty page; an
 * unsafe session id throws before anything is opened.
 */
export async function searchSession(
  sessionId: string,
  options: SessionPageOptions = {},
): Promise<SessionPage> {
  assertValidSessionId(sessionId)
  const dir = options.dir ?? JOURNAL_DIR
  const handle = await openJournalDbIfPresent(dir)
  if (handle === null || !dbHasSession(handle, sessionId)) {
    return emptyPage(options)
  }
  return dbSearchSession(handle, sessionId, options)
}

/**
 * The page a session with nothing to show answers with. Offset and limit are
 * normalized exactly as a real page's are, so a caller's pagination controls
 * read the same whether or not the session exists.
 */
function emptyPage(options: SessionPageOptions): SessionPage {
  return {
    records: [],
    offset: normalizeOffset(options.offset),
    limit: normalizeLimit(options.limit, DEFAULT_PAGE_LIMIT),
    scannedLineCount: 0,
    skippedLineCount: 0,
    hasMore: false,
    truncated: false,
  }
}

/**
 * Walks the database's sessions from newest to oldest, collecting matching
 * records under three explicit ceilings: sessions opened, bytes read and
 * wall-clock time. A walk that hit one reports `truncated: true` with the
 * reason and how many of the directory's sessions it managed to look at, so a
 * caller can say "scanned N of M, stopped by <reason>" instead of presenting a
 * partial answer as the whole one.
 *
 * A directory with no `journal.db` has nothing to walk: an empty result with
 * `filesTotal: 0`, not a failure.
 */
export async function searchAllSessions(
  options: CrossSessionSearchOptions = {},
): Promise<CrossSessionSearchResult> {
  const dir = options.dir ?? JOURNAL_DIR
  const handle = await openJournalDbIfPresent(dir)
  if (handle === null) {
    return EMPTY_CROSS_SESSION_RESULT
  }
  return dbSearchAllSessions(handle, options, Date.now)
}

/** Nothing to walk: no database in this journal directory. */
const EMPTY_CROSS_SESSION_RESULT: CrossSessionSearchResult = {
  hits: [],
  truncated: false,
  stoppedBy: null,
  filesScanned: 0,
  filesTotal: 0,
  bytesRead: 0,
  skippedLineCount: 0,
}
