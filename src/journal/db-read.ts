import type { SqliteHandle } from '../store/sqlite.js'
import { epochMsOf, numberOf, textOf } from './db-row.js'
import { parseJournalLine } from './line-source.js'
import type { JournalRecord } from './record.js'
import type {
  CrossSessionHit,
  CrossSessionSearchOptions,
  CrossSessionSearchResult,
  ScanStopReason,
  SessionPage,
  SessionPageOptions,
} from './search.js'
import {
  CROSS_SESSION_DEFAULT_LIMIT,
  CROSS_SESSION_MAX_BYTES,
  CROSS_SESSION_MAX_FILES,
  CROSS_SESSION_TIME_BUDGET_MS,
  DEADLINE_CHECK_LINE_INTERVAL,
  DEFAULT_PAGE_LIMIT,
  MAX_SCANNED_LINES_PER_SESSION,
  normalizeLimit,
  normalizeOffset,
} from './search-limits.js'
import { matchesWithNeedle, textNeedleOf, type JournalFilters } from './search-filters.js'

/**
 * The SQL arm of the journal's read side: everything `search.ts` offers over a
 * JSONL file, served from `journal.db`'s rows instead. It exists beside the
 * file arm rather than replacing it because un-imported legacy sessions stay
 * readable (wave-4 decision 5); the routing between the two lives in
 * `search.ts`/`reader.ts`/`index-cache.ts`, never here.
 *
 * The loops below deliberately mirror the file arm's rather than expressing
 * "equivalent" SQL, because two properties are load-bearing:
 * - **identical answers.** `hasMore`, `truncated`, `stoppedBy` and the scan
 *   and skip counts must not depend on which carrier a session happens to
 *   live in, or an operator's page would change meaning after a migration.
 *   Filters are `matchesWithNeedle` verbatim and validation is
 *   `parseJournalLine` verbatim — reimplementing either in SQL is how the two
 *   arms would drift. `doc` stays the source of truth on the way out as it is
 *   on the way in: a row that fails validation is counted and skipped, never
 *   trusted (MALFORMED_SKIP);
 * - **bounded cost.** A page reads `offset + limit + 1` matching rows and
 *   stops; a walk stops at the first ceiling it hits and says which one.
 *
 * The ceilings come from `search-limits.ts`, which both arms share so neither
 * can drift from the other's numbers. What is left of the `search.ts` import
 * is types alone, erased at build time: `search.ts` imports this module for
 * routing, and that is a one-way edge at runtime rather than a cycle to
 * reason about. Nothing here reads another module's bindings at
 * module-evaluation time, only inside functions — keep it that way.
 */

/**
 * Rows stream through `StatementSync.iterate()` rather than `.all()`: a
 * session may hold millions of rows and a page needs a handful, so
 * materializing one would give up the whole point of the ceiling. `.iterate()`
 * is present on the pinned Node 24 floor, so the chunked `… AND seq > ? LIMIT
 * n` fallback is not needed; breaking out of the loop resets the statement,
 * which keeps an early stop from pinning a cursor.
 */
const SELECT_SESSION_DOCS = 'SELECT doc FROM journal_records WHERE session_id = ? ORDER BY seq'

/**
 * One indexed aggregate answers the whole session list. `MIN`/`MAX` over `ts`
 * are lexicographic, which is chronological here because `ts` is fixed-width
 * ISO-8601 UTC (`record.ts` builds it with `toISOString()`).
 */
const SELECT_SESSION_AGGREGATES =
  'SELECT session_id AS sessionId, MIN(ts) AS firstTs, MAX(ts) AS lastTs, ' +
  'COUNT(*) AS recordCount, SUM(LENGTH(doc)) AS docLength ' +
  'FROM journal_records GROUP BY session_id'

/**
 * The walk order: every session by its last write, newest first. The whole
 * cross-session budget is spent before this returns, so it has to cost what
 * the answer is worth — twenty-odd rows — rather than what the table weighs.
 *
 * Ordering is by `MAX(seq)`, not `MAX(ts)`. Highest `seq` IS the session's
 * last write, which is exactly what the file arm sorts by when it orders
 * session FILES by mtime, and `seq` is the INTEGER PRIMARY KEY carried in
 * `idx_journal_session_seq` `(session_id, seq)` while `ts` is in no index at
 * all. Ordering by `ts` therefore fetches every row to read it: 14-16 s cold
 * over 1M rows, which spent the 3000 ms deadline before the walk opened its
 * first session and returned zero hits with `stoppedBy: 'deadline'`.
 *
 * The plain `GROUP BY session_id` form of the same aggregate was measured and
 * rejected too. It is index-only, but SQLite has no loose index scan for a
 * grouped aggregate, so it still visits all 1M index entries to find twenty
 * maxima — ~75 ms p50 / ~110 ms p95 at 1M rows, over the 50 ms search gate on
 * its own and growing with the journal rather than with the session count.
 *
 * Hence the recursive CTE: it hops from one distinct `session_id` to the next
 * through the index (`MIN(session_id) WHERE session_id > previous`), then
 * takes one `MAX(seq)` seek per session found. That is O(sessions × log rows)
 * instead of O(rows) — ~0.08 ms at 1M rows, for a byte-identical row set. No
 * tie-break is needed or wanted: `seq` is unique, so this order is already
 * total and a walk that stops early is reproducible.
 */
const SELECT_SESSION_LAST_SEQ =
  'WITH RECURSIVE distinct_sessions(session_id) AS (' +
  'SELECT MIN(session_id) FROM journal_records ' +
  'UNION ALL ' +
  'SELECT (SELECT MIN(r.session_id) FROM journal_records r WHERE r.session_id > d.session_id) ' +
  'FROM distinct_sessions d WHERE d.session_id IS NOT NULL) ' +
  'SELECT session_id AS sessionId, ' +
  '(SELECT MAX(seq) FROM journal_records r WHERE r.session_id = distinct_sessions.session_id) ' +
  'AS lastSeq FROM distinct_sessions WHERE session_id IS NOT NULL ORDER BY lastSeq DESC'

/** Rows OR an import marker: an imported session with no rows left is still this database's. */
const SELECT_SESSION_PRESENCE =
  'SELECT (EXISTS(SELECT 1 FROM journal_records WHERE session_id = ?) ' +
  'OR EXISTS(SELECT 1 FROM imported_sessions WHERE session_id = ?)) AS present'

/** One session's summary as the columns alone can tell it. */
export interface DbSessionSummary {
  readonly sessionId: string
  readonly firstTs: string
  readonly lastTs: string
  readonly count: number
  /**
   * Always 0, deliberately: the aggregate never parses a `doc`, which is the
   * entire reason it is one query instead of a scan — a malformed row counts
   * as a record here and is skipped only when someone actually reads it. The
   * field stays in the shape because these summaries merge with the file
   * arm's, where the count is real.
   */
  readonly skippedLineCount: number
  /** Stands in for the file arm's byte size: the total length of the session's `doc` text. */
  readonly size: number
  /** Stands in for the file arm's mtime: last activity, as epoch milliseconds. */
  readonly mtimeMs: number
}

/** Every session in the database, most recent activity first. */
export function dbSessionSummaries(handle: SqliteHandle): DbSessionSummary[] {
  return handle.db
    .prepare(SELECT_SESSION_AGGREGATES)
    .all()
    .map((row): DbSessionSummary => {
      const lastTs = textOf(row['lastTs'])
      return {
        sessionId: textOf(row['sessionId']),
        firstTs: textOf(row['firstTs']),
        lastTs,
        count: numberOf(row['recordCount']),
        skippedLineCount: 0,
        size: numberOf(row['docLength']),
        mtimeMs: epochMsOf(lastTs),
      }
    })
    .sort((a, b) => b.lastTs.localeCompare(a.lastTs))
}

/** True when this database is the carrier for `sessionId` — the routing question. */
export function dbHasSession(handle: SqliteHandle, sessionId: string): boolean {
  const row = handle.db.prepare(SELECT_SESSION_PRESENCE).get(sessionId, sessionId)
  return row !== undefined && numberOf(row['present']) === 1
}

/**
 * One page of a session's records. Reading stops as soon as the page is full
 * and one further match has been seen (that match is the `hasMore` answer and
 * is not kept), or as soon as `maxScannedLines` rows have been examined. A
 * session with no rows yields an empty page.
 *
 * `sessionId` travels as a bound parameter, and the routing entry points
 * validate it before choosing an arm, so no path is built from it here.
 */
export function dbSearchSession(
  handle: SqliteHandle,
  sessionId: string,
  options: SessionPageOptions = {},
): SessionPage {
  const offset = normalizeOffset(options.offset)
  const limit = normalizeLimit(options.limit, DEFAULT_PAGE_LIMIT)
  const maxScannedLines = options.maxScannedLines ?? MAX_SCANNED_LINES_PER_SESSION
  const textNeedle = textNeedleOf(options)

  const records: JournalRecord[] = []
  let matchedCount = 0
  let scannedLineCount = 0
  let skippedLineCount = 0
  let hasMore = false
  let truncated = false

  for (const doc of iterateSessionDocs(handle, sessionId)) {
    if (scannedLineCount >= maxScannedLines) {
      truncated = true
      break
    }
    scannedLineCount += 1
    const record = parseJournalLine(doc)
    if (record === null) {
      // Unlike a file line, a `doc` is never blank — the column is NOT NULL and
      // the sink always writes a serialized record — so every rejection is a
      // real malformed row rather than the file arm's ignorable empty line.
      skippedLineCount += 1
      continue
    }
    if (!matchesWithNeedle(record, options, textNeedle)) {
      continue
    }
    matchedCount += 1
    if (matchedCount <= offset) {
      continue
    }
    if (records.length < limit) {
      records.push(record)
      continue
    }
    hasMore = true
    break
  }

  return { records, offset, limit, scannedLineCount, skippedLineCount, hasMore, truncated }
}

/**
 * Walks the database's sessions from newest to oldest under the same three
 * ceilings the file arm applies — sessions opened, bytes examined and
 * wall-clock time — and reports which one stopped it. `bytesRead` counts
 * `doc` bytes plus one, so the budget keeps meaning "payload volume examined"
 * whichever carrier answered.
 */
export function dbSearchAllSessions(
  handle: SqliteHandle,
  options: CrossSessionSearchOptions,
  now: () => number,
): CrossSessionSearchResult {
  const hitLimit = normalizeLimit(options.limit, CROSS_SESSION_DEFAULT_LIMIT)
  const ceilings: WalkCeilings = {
    hitLimit,
    maxFiles: options.maxFiles ?? CROSS_SESSION_MAX_FILES,
    maxBytes: options.maxBytes ?? CROSS_SESSION_MAX_BYTES,
    deadlineAt: now() + (options.timeBudgetMs ?? CROSS_SESSION_TIME_BUDGET_MS),
  }
  const sessionIds = sessionIdsNewestFirst(handle)
  const walk = walkSessions(handle, sessionIds, options, now, ceilings)

  return {
    hits: walk.hits.slice(0, hitLimit),
    truncated: walk.stoppedBy !== null,
    stoppedBy: walk.stoppedBy,
    filesScanned: walk.filesScanned,
    filesTotal: sessionIds.length,
    bytesRead: walk.bytesRead,
    skippedLineCount: walk.skippedLineCount,
  }
}

interface WalkCeilings {
  readonly hitLimit: number
  readonly maxFiles: number
  readonly maxBytes: number
  readonly deadlineAt: number
}

interface WalkOutcome {
  readonly hits: readonly CrossSessionHit[]
  readonly filesScanned: number
  readonly bytesRead: number
  readonly skippedLineCount: number
  readonly stoppedBy: ScanStopReason | null
}

/** Scans sessions in order until one of the ceilings stops the walk. */
function walkSessions(
  handle: SqliteHandle,
  sessionIds: readonly string[],
  filters: JournalFilters,
  now: () => number,
  ceilings: WalkCeilings,
): WalkOutcome {
  const hits: CrossSessionHit[] = []
  let filesScanned = 0
  let bytesRead = 0
  let skippedLineCount = 0
  let stoppedBy: ScanStopReason | null = null

  for (const sessionId of sessionIds) {
    stoppedBy = nextSessionStopReason({ filesScanned, bytesRead }, ceilings, now)
    if (stoppedBy !== null) {
      break
    }
    filesScanned += 1
    const outcome = scanSessionForHits(handle, sessionId, filters, now, {
      // One hit past the limit is collected on purpose: whether it exists is
      // what makes `truncated` exact instead of "we stopped, maybe there was
      // more".
      remainingHits: ceilings.hitLimit + 1 - hits.length,
      remainingBytes: ceilings.maxBytes - bytesRead,
      deadlineAt: ceilings.deadlineAt,
    })
    hits.push(...outcome.hits)
    bytesRead += outcome.bytesRead
    skippedLineCount += outcome.skippedLineCount
    stoppedBy = outcome.stoppedBy
    if (stoppedBy !== null) {
      break
    }
  }

  return { hits, filesScanned, bytesRead, skippedLineCount, stoppedBy }
}

/** Which ceiling, if any, forbids opening one more session. */
function nextSessionStopReason(
  spent: { readonly filesScanned: number; readonly bytesRead: number },
  ceilings: WalkCeilings,
  now: () => number,
): ScanStopReason | null {
  if (spent.filesScanned >= ceilings.maxFiles) {
    return 'files'
  }
  if (spent.bytesRead >= ceilings.maxBytes) {
    return 'bytes'
  }
  return now() >= ceilings.deadlineAt ? 'deadline' : null
}

interface SessionScanBudget {
  readonly remainingHits: number
  readonly remainingBytes: number
  readonly deadlineAt: number
}

interface SessionScanOutcome {
  readonly hits: readonly CrossSessionHit[]
  readonly bytesRead: number
  readonly skippedLineCount: number
  readonly stoppedBy: ScanStopReason | null
}

/** Streams one session's rows, collecting hits until one of its budgets runs out. */
function scanSessionForHits(
  handle: SqliteHandle,
  sessionId: string,
  filters: JournalFilters,
  now: () => number,
  budget: SessionScanBudget,
): SessionScanOutcome {
  const hits: CrossSessionHit[] = []
  const textNeedle = textNeedleOf(filters)
  let bytesRead = 0
  let skippedLineCount = 0
  let rowsSinceClockCheck = 0
  let stoppedBy: ScanStopReason | null = null

  for (const doc of iterateSessionDocs(handle, sessionId)) {
    bytesRead += Buffer.byteLength(doc, 'utf8') + 1
    const record = parseJournalLine(doc)
    if (record === null) {
      skippedLineCount += 1
    } else if (matchesWithNeedle(record, filters, textNeedle)) {
      hits.push({ sessionId, record })
    }
    if (hits.length >= budget.remainingHits) {
      stoppedBy = 'limit'
      break
    }
    if (bytesRead >= budget.remainingBytes) {
      stoppedBy = 'bytes'
      break
    }
    rowsSinceClockCheck += 1
    if (rowsSinceClockCheck >= DEADLINE_CHECK_LINE_INTERVAL) {
      rowsSinceClockCheck = 0
      if (now() >= budget.deadlineAt) {
        stoppedBy = 'deadline'
        break
      }
    }
  }

  return { hits, bytesRead, skippedLineCount, stoppedBy }
}

/**
 * Session ids by last write, newest first — the order a walk visits them in,
 * mirroring the file arm's newest-mtime-first order. SQL does the ordering
 * because the index can; see `SELECT_SESSION_LAST_SEQ` for why that matters.
 */
function sessionIdsNewestFirst(handle: SqliteHandle): readonly string[] {
  return handle.db
    .prepare(SELECT_SESSION_LAST_SEQ)
    .all()
    .map((row) => textOf(row['sessionId']))
}

/**
 * One session's `doc` texts in `seq` order, one row at a time. Exported for
 * `db-read-session.ts`, the session-scoped half of this arm.
 */
export function* iterateSessionDocs(handle: SqliteHandle, sessionId: string): Generator<string> {
  for (const row of handle.db.prepare(SELECT_SESSION_DOCS).iterate(sessionId)) {
    yield textOf(row['doc'])
  }
}
