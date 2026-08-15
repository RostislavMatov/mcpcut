import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import { dbHasSession, dbSearchAllSessions, dbSearchSession } from './db-read.js'
import {
  armOptions,
  isShadowedByDb,
  mergeCrossSessionResults,
  NO_SPEND,
  openJournalDbIfPresent,
} from './read-routing.js'
import {
  isBlankLine,
  journalPath,
  listSessionFilesNewestFirst,
  parseJournalLine,
  resolveJournalReadDeps,
  type JournalReadDeps,
  type SessionFile,
} from './line-source.js'
import type { JournalRecord } from './record.js'
import {
  matchesWithNeedle,
  textNeedleOf,
  type JournalFilters,
} from './search-filters.js'
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
import { assertValidSessionId } from './session-id.js'

/**
 * Read side of the journal for interactive callers (the admin UI): paged,
 * filtered, streaming access to JSONL session files with a hard cost ceiling
 * at every level. `reader.ts` stays as it is — it materializes a whole
 * session, which is right for a one-shot CLI print and wrong for a page an
 * operator refreshes.
 *
 * Two rules hold throughout:
 * - nothing is read that the caller did not ask for. A page stops as soon as
 *   it is full and one further match has been seen, so cost follows
 *   `offset + limit`, not file size;
 * - every walk is bounded by named limits, and a walk that hit one says so
 *   (`truncated`, `stoppedBy`, `filesScanned` of `filesTotal`). Silently
 *   partial output is worse than a refusal in an audit product.
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

/** Re-exported so a caller gets the whole read layer from one module. */
export { defaultJournalReadDeps, type JournalFileStat, type JournalReadDeps } from './line-source.js'

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
 * answer and is not kept). A missing file or directory yields an empty page;
 * an unsafe session id throws before any path is built.
 *
 * A session `journal.db` holds is answered from there (`db-read.ts`), with
 * identical paging semantics; everything else is the file arm below. `deps`
 * belongs to the file arm alone — it is the filesystem seam, and there is no
 * filesystem under the SQL one.
 */
export async function searchSession(
  sessionId: string,
  options: SessionPageOptions = {},
  deps: Partial<JournalReadDeps> = {},
): Promise<SessionPage> {
  assertValidSessionId(sessionId)
  const dir = options.dir ?? JOURNAL_DIR
  const handle = await openJournalDbIfPresent(dir)
  if (handle !== null && dbHasSession(handle, sessionId)) {
    return dbSearchSession(handle, sessionId, options)
  }

  const { readLines } = resolveJournalReadDeps(deps)
  const offset = normalizeOffset(options.offset)
  const limit = normalizeLimit(options.limit, DEFAULT_PAGE_LIMIT)
  const maxScannedLines = options.maxScannedLines ?? MAX_SCANNED_LINES_PER_SESSION
  const filePath = journalPath(dir, sessionId)

  const records: JournalRecord[] = []
  const textNeedle = textNeedleOf(options)
  let matchedCount = 0
  let scannedLineCount = 0
  let skippedLineCount = 0
  let hasMore = false
  let truncated = false

  for await (const line of readLines(filePath)) {
    if (scannedLineCount >= maxScannedLines) {
      truncated = true
      break
    }
    scannedLineCount += 1
    const record = parseJournalLine(line)
    if (record === null) {
      skippedLineCount += isBlankLine(line) ? 0 : 1
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
 * Walks session files from newest to oldest, collecting matching records under
 * three explicit ceilings: files opened, bytes read and wall-clock time. A
 * walk that hit one reports `truncated: true` with the reason and how many of
 * the directory's files it managed to look at, so a caller can say "scanned N
 * of M files, stopped by <reason>" instead of presenting a partial answer as
 * the whole one.
 *
 * Where a `journal.db` exists, its sessions are walked first (newest first),
 * then the legacy files it does not already speak for — one walk over two
 * carriers, under ONE set of ceilings: each arm's budget is the caller's
 * minus what the previous arm spent (`read-routing.armOptions`), so the two
 * together never open more sessions, read more bytes or take longer than a
 * single-carrier search would have.
 */
export async function searchAllSessions(
  options: CrossSessionSearchOptions = {},
  deps: Partial<JournalReadDeps> = {},
): Promise<CrossSessionSearchResult> {
  const resolved = resolveJournalReadDeps(deps)
  const dir = options.dir ?? JOURNAL_DIR
  const handle = await openJournalDbIfPresent(dir)
  if (handle === null) {
    return searchFileArm(options, dir, resolved, NOTHING_SHADOWED)
  }

  const ceilings = crossSessionCeilings(options, resolved.now())
  const fromDb = dbSearchAllSessions(
    handle,
    armOptions(options, ceilings, NO_SPEND, resolved.now()),
    resolved.now,
  )
  if (fromDb.stoppedBy !== null) {
    // The database already spent a ceiling the caller was told about. Opening
    // a legacy file now would exceed it, and reporting "stopped by bytes"
    // after reading past the byte budget is worse than stopping.
    return fromDb
  }
  const rest = armOptions(options, ceilings, fromDb, resolved.now())
  const fromFiles = await searchFileArm(rest, dir, resolved, isShadowedByDb(handle))
  return mergeCrossSessionResults(fromDb, fromFiles, ceilings.hitLimit)
}

/** No database, so no session is spoken for by one. */
const NOTHING_SHADOWED = (): boolean => false

/** The caller's ceilings with the defaults filled in, resolved once per arm. */
function crossSessionCeilings(options: CrossSessionSearchOptions, nowMs: number): WalkCeilings {
  return {
    hitLimit: normalizeLimit(options.limit, CROSS_SESSION_DEFAULT_LIMIT),
    maxFiles: options.maxFiles ?? CROSS_SESSION_MAX_FILES,
    maxBytes: options.maxBytes ?? CROSS_SESSION_MAX_BYTES,
    deadlineAt: nowMs + (options.timeBudgetMs ?? CROSS_SESSION_TIME_BUDGET_MS),
  }
}

/**
 * The file arm of a cross-session search: the walk as it always was, minus
 * the sessions the database is the carrier for. `filesTotal` counts what this
 * arm could have opened, so a merged result's total is "sessions in the
 * database" plus "legacy files not shadowed by one" — every session exactly
 * once.
 */
async function searchFileArm(
  options: CrossSessionSearchOptions,
  dir: string,
  resolved: JournalReadDeps,
  isShadowed: (sessionId: string) => boolean,
): Promise<CrossSessionSearchResult> {
  const ceilings = crossSessionCeilings(options, resolved.now())
  const found = await listSessionFilesNewestFirst(dir, resolved)
  const files = found.filter((file) => !isShadowed(file.sessionId))
  const walk = await walkSessionFiles(files, dir, options, resolved, ceilings)

  return {
    hits: walk.hits.slice(0, ceilings.hitLimit),
    truncated: walk.stoppedBy !== null,
    stoppedBy: walk.stoppedBy,
    filesScanned: walk.filesScanned,
    filesTotal: files.length,
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

/** Scans files in order until one of the ceilings stops the walk. */
async function walkSessionFiles(
  files: readonly SessionFile[],
  dir: string,
  filters: JournalFilters,
  deps: JournalReadDeps,
  ceilings: WalkCeilings,
): Promise<WalkOutcome> {
  const hits: CrossSessionHit[] = []
  let filesScanned = 0
  let bytesRead = 0
  let skippedLineCount = 0
  let stoppedBy: ScanStopReason | null = null

  for (const file of files) {
    stoppedBy = nextFileStopReason({ filesScanned, bytesRead }, ceilings, deps)
    if (stoppedBy !== null) {
      break
    }
    filesScanned += 1
    const outcome = await scanFileForHits(join(dir, file.fileName), file.sessionId, filters, deps, {
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

/** Which ceiling, if any, forbids opening one more file. */
function nextFileStopReason(
  spent: { readonly filesScanned: number; readonly bytesRead: number },
  ceilings: WalkCeilings,
  deps: JournalReadDeps,
): ScanStopReason | null {
  if (spent.filesScanned >= ceilings.maxFiles) {
    return 'files'
  }
  if (spent.bytesRead >= ceilings.maxBytes) {
    return 'bytes'
  }
  return deps.now() >= ceilings.deadlineAt ? 'deadline' : null
}

interface FileScanBudget {
  readonly remainingHits: number
  readonly remainingBytes: number
  readonly deadlineAt: number
}

interface FileScanOutcome {
  readonly hits: readonly CrossSessionHit[]
  readonly bytesRead: number
  readonly skippedLineCount: number
  readonly stoppedBy: ScanStopReason | null
}

/** Streams one file, collecting hits until one of its budgets runs out. */
async function scanFileForHits(
  filePath: string,
  sessionId: string,
  filters: JournalFilters,
  deps: JournalReadDeps,
  budget: FileScanBudget,
): Promise<FileScanOutcome> {
  const hits: CrossSessionHit[] = []
  const textNeedle = textNeedleOf(filters)
  let bytesRead = 0
  let skippedLineCount = 0
  let linesSinceClockCheck = 0
  let stoppedBy: ScanStopReason | null = null

  for await (const line of deps.readLines(filePath)) {
    bytesRead += Buffer.byteLength(line, 'utf8') + 1
    const record = parseJournalLine(line)
    if (record === null) {
      skippedLineCount += isBlankLine(line) ? 0 : 1
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
    linesSinceClockCheck += 1
    if (linesSinceClockCheck >= DEADLINE_CHECK_LINE_INTERVAL) {
      linesSinceClockCheck = 0
      if (deps.now() >= budget.deadlineAt) {
        stoppedBy = 'deadline'
        break
      }
    }
  }

  return { hits, bytesRead, skippedLineCount, stoppedBy }
}
