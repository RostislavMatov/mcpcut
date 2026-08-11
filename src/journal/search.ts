import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import {
  isBlankLine,
  journalPath,
  listSessionFilesNewestFirst,
  parseJournalLine,
  resolveJournalReadDeps,
  type JournalReadDeps,
  type SessionFile,
} from './line-source.js'
import type { JournalDirection, JournalRecord } from './record.js'
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

/** Page size used when the caller does not ask for one. */
export const DEFAULT_PAGE_LIMIT = 100

/** Largest page any caller can ask for; larger requests are clamped. */
export const MAX_PAGE_LIMIT = 1000

/** Lines one session search may walk before the page is marked truncated. */
export const MAX_SCANNED_LINES_PER_SESSION = 200_000

/** Default hit ceiling for a cross-session search. */
export const CROSS_SESSION_DEFAULT_LIMIT = 200

/** Files a cross-session search may open before it stops. */
export const CROSS_SESSION_MAX_FILES = 50

/** Bytes a cross-session search may read before it stops. */
export const CROSS_SESSION_MAX_BYTES = 64 * 1024 * 1024

/** Wall-clock budget for one cross-session search. */
export const CROSS_SESSION_TIME_BUDGET_MS = 3000

/**
 * Lines between two clock reads inside one file. Checking the deadline on
 * every line would cost a clock call per record; checking only at file
 * boundaries would let one huge file overrun the budget without noticing.
 */
export const DEADLINE_CHECK_LINE_INTERVAL = 500

/** Re-exported so a caller gets the whole read layer from one module. */
export { defaultJournalReadDeps, type JournalFileStat, type JournalReadDeps } from './line-source.js'

/** Filters shared by single-session and cross-session searches. */
export interface JournalFilters {
  readonly kind?: string
  readonly direction?: JournalDirection
  readonly method?: string
  /** Tool name of a `decision` record. */
  readonly toolName?: string
  /** Policy outcome of a `decision` record. */
  readonly outcome?: string
  /** Case-insensitive substring over payload, method and decision fields. */
  readonly text?: string
}

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
 */
export async function searchSession(
  sessionId: string,
  options: SessionPageOptions = {},
  deps: Partial<JournalReadDeps> = {},
): Promise<SessionPage> {
  assertValidSessionId(sessionId)
  const { readLines } = resolveJournalReadDeps(deps)
  const offset = normalizeOffset(options.offset)
  const limit = normalizeLimit(options.limit, DEFAULT_PAGE_LIMIT)
  const maxScannedLines = options.maxScannedLines ?? MAX_SCANNED_LINES_PER_SESSION
  const filePath = journalPath(options.dir ?? JOURNAL_DIR, sessionId)

  const records: JournalRecord[] = []
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
    if (!matchesFilters(record, options)) {
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
 */
export async function searchAllSessions(
  options: CrossSessionSearchOptions = {},
  deps: Partial<JournalReadDeps> = {},
): Promise<CrossSessionSearchResult> {
  const resolved = resolveJournalReadDeps(deps)
  const dir = options.dir ?? JOURNAL_DIR
  const hitLimit = normalizeLimit(options.limit, CROSS_SESSION_DEFAULT_LIMIT)
  const ceilings: WalkCeilings = {
    hitLimit,
    maxFiles: options.maxFiles ?? CROSS_SESSION_MAX_FILES,
    maxBytes: options.maxBytes ?? CROSS_SESSION_MAX_BYTES,
    deadlineAt: resolved.now() + (options.timeBudgetMs ?? CROSS_SESSION_TIME_BUDGET_MS),
  }
  const files = await listSessionFilesNewestFirst(dir, resolved)
  const walk = await walkSessionFiles(files, dir, options, resolved, ceilings)

  return {
    hits: walk.hits.slice(0, hitLimit),
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
  let bytesRead = 0
  let skippedLineCount = 0
  let linesSinceClockCheck = 0
  let stoppedBy: ScanStopReason | null = null

  for await (const line of deps.readLines(filePath)) {
    bytesRead += Buffer.byteLength(line, 'utf8') + 1
    const record = parseJournalLine(line)
    if (record === null) {
      skippedLineCount += isBlankLine(line) ? 0 : 1
    } else if (matchesFilters(record, filters)) {
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

/** True when `record` satisfies every filter that was supplied. */
export function matchesFilters(record: JournalRecord, filters: JournalFilters): boolean {
  if (filters.kind !== undefined && record.kind !== filters.kind) {
    return false
  }
  if (filters.direction !== undefined && record.direction !== filters.direction) {
    return false
  }
  if (filters.method !== undefined && record.method !== filters.method) {
    return false
  }
  if (filters.toolName !== undefined && record.decision?.toolName !== filters.toolName) {
    return false
  }
  if (filters.outcome !== undefined && record.decision?.outcome !== filters.outcome) {
    return false
  }
  if (filters.text !== undefined && filters.text.length > 0) {
    return searchableText(record).includes(filters.text.toLowerCase())
  }
  return true
}

/**
 * The text a substring filter runs against: payload, method and the decision's
 * short fields. Built only when a substring filter is present, because
 * serializing every payload of every scanned record is the expensive part of a
 * text search.
 */
function searchableText(record: JournalRecord): string {
  const decision = record.decision
  const parts = [
    record.method ?? '',
    decision === undefined ? '' : `${decision.toolName} ${decision.rule} ${decision.serverName}`,
    stringifyPayload(record.payload),
  ]
  return parts.join(' ').toLowerCase()
}

function stringifyPayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload
  }
  try {
    return JSON.stringify(payload) ?? ''
  } catch {
    // A payload that cannot be serialized (cyclic, BigInt) is not searchable,
    // but it must not break the scan it appears in.
    return ''
  }
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) {
    return 0
  }
  return Math.max(0, Math.floor(offset))
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return fallback
  }
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(limit)))
}
