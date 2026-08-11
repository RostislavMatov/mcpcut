import { LIST_SESSIONS_CONCURRENCY, JOURNAL_DIR } from '../config.js'
import { mapWithConcurrency } from './concurrency.js'
import {
  isBlankLine,
  journalPath,
  parseJournalLine,
  resolveJournalReadDeps,
  sessionIdOf,
  type JournalReadDeps,
} from './line-source.js'
import { assertValidSessionId } from './session-id.js'

/**
 * In-memory summary cache for the session list.
 *
 * `reader.listSessions()` re-reads every journal file on every call, which is
 * right for a one-shot CLI print and wrong for a page an operator refreshes:
 * the cost grows with the whole journal, not with what changed. A JSONL file
 * is append-only, so `stat()` answers "did this change?" for a fraction of the
 * cost of reading it — size *and* mtime together, because either one alone can
 * stay put across a rewrite (same-length edit, or a restored timestamp).
 *
 * Deliberately not persisted: a cache on disk beside the journal would be a
 * second place claiming to know what the journal says, and this one is
 * rebuildable in the time it takes to read the files once.
 */

/** Cached summary of one session file. */
export interface SessionSummaryEntry {
  readonly sessionId: string
  readonly firstTs: string
  readonly lastTs: string
  readonly count: number
  readonly skippedLineCount: number
  readonly size: number
  readonly mtimeMs: number
}

export interface SessionIndexCacheOptions {
  /** Summaries kept before the least recently used one is dropped. */
  readonly maxEntries?: number
}

export interface SessionIndexCache {
  /** Every session in `dir`, newest activity first; missing dir yields []. */
  readonly listSessions: (dir?: string) => Promise<readonly SessionSummaryEntry[]>
  /** One session's summary, or null when it has no readable record. */
  readonly getSession: (sessionId: string, dir?: string) => Promise<SessionSummaryEntry | null>
  /** Drops one session's cached summary. */
  readonly invalidate: (sessionId: string, dir?: string) => void
  /** Drops every cached summary. */
  readonly clear: () => void
  /** Number of summaries currently cached (test and diagnostics seam). */
  readonly cachedCount: () => number
}

/** Default cache size: enough for a long-lived plane, bounded for a daemon. */
export const DEFAULT_MAX_CACHED_SESSIONS = 500

interface CachedSummary {
  readonly size: number
  readonly mtimeMs: number
  /** Null means "this file holds no readable record" — cached like any other
   * verdict, so a directory of noise is not re-read on every refresh. */
  readonly summary: SessionSummaryEntry | null
}

/**
 * Creates a summary cache. `deps` is the same injectable filesystem seam the
 * search layer uses, so a test can count exactly how many lines a refresh read.
 */
export function createSessionIndexCache(
  deps: Partial<JournalReadDeps> = {},
  options: SessionIndexCacheOptions = {},
): SessionIndexCache {
  const resolved = resolveJournalReadDeps(deps)
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_CACHED_SESSIONS)
  const cache = new Map<string, CachedSummary>()

  async function summaryFor(dir: string, sessionId: string): Promise<SessionSummaryEntry | null> {
    const filePath = journalPath(dir, sessionId)
    const info = await resolved.statFile(filePath)
    if (info === null) {
      cache.delete(filePath)
      return null
    }
    const cached = takeFresh(cache, filePath, info.size, info.mtimeMs)
    if (cached !== undefined) {
      return cached.summary
    }
    const scanned = await summarizeFile(filePath, sessionId, resolved)
    const summary = scanned === null ? null : { ...scanned, size: info.size, mtimeMs: info.mtimeMs }
    store(cache, filePath, { size: info.size, mtimeMs: info.mtimeMs, summary }, maxEntries)
    return summary
  }

  async function listSessions(dir: string = JOURNAL_DIR): Promise<readonly SessionSummaryEntry[]> {
    const sessionIds = (await resolved.listFiles(dir))
      .map(sessionIdOf)
      .filter((sessionId): sessionId is string => sessionId !== null)
    const summaries = await mapWithConcurrency(sessionIds, LIST_SESSIONS_CONCURRENCY, (sessionId) =>
      summaryFor(dir, sessionId),
    )
    return summaries
      .filter((entry): entry is SessionSummaryEntry => entry !== null)
      .sort((a, b) => b.lastTs.localeCompare(a.lastTs))
  }

  async function getSession(
    sessionId: string,
    dir: string = JOURNAL_DIR,
  ): Promise<SessionSummaryEntry | null> {
    assertValidSessionId(sessionId)
    return summaryFor(dir, sessionId)
  }

  function invalidate(sessionId: string, dir: string = JOURNAL_DIR): void {
    assertValidSessionId(sessionId)
    cache.delete(journalPath(dir, sessionId))
  }

  return {
    listSessions,
    getSession,
    invalidate,
    clear: () => cache.clear(),
    cachedCount: () => cache.size,
  }
}

/**
 * Returns the cached entry when it still describes the file on disk, marking
 * it most recently used. A difference in either size or mtime is a miss: both
 * are checked because either can survive a change on its own.
 */
function takeFresh(
  cache: Map<string, CachedSummary>,
  filePath: string,
  size: number,
  mtimeMs: number,
): CachedSummary | undefined {
  const cached = cache.get(filePath)
  if (cached === undefined || cached.size !== size || cached.mtimeMs !== mtimeMs) {
    return undefined
  }
  cache.delete(filePath)
  cache.set(filePath, cached)
  return cached
}

/** Inserts an entry as most recently used, evicting the oldest past the cap. */
function store(
  cache: Map<string, CachedSummary>,
  filePath: string,
  entry: CachedSummary,
  maxEntries: number,
): void {
  cache.delete(filePath)
  cache.set(filePath, entry)
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next()
    if (oldest.done === true) {
      return
    }
    cache.delete(oldest.value)
  }
}

type ScannedSummary = Omit<SessionSummaryEntry, 'size' | 'mtimeMs'>

/**
 * Streams a session file to derive its summary. Only the first and last
 * readable timestamps and two counters are kept, so the memory cost is the
 * same for a one-line journal and a gigabyte one. A file with no readable
 * record yields null, mirroring `reader.listSessions()`.
 */
async function summarizeFile(
  filePath: string,
  sessionId: string,
  deps: JournalReadDeps,
): Promise<ScannedSummary | null> {
  let firstTs: string | null = null
  let lastTs = ''
  let count = 0
  let skippedLineCount = 0

  for await (const line of deps.readLines(filePath)) {
    const record = parseJournalLine(line)
    if (record === null) {
      skippedLineCount += isBlankLine(line) ? 0 : 1
      continue
    }
    firstTs ??= record.ts
    lastTs = record.ts
    count += 1
  }

  return firstTs === null ? null : { sessionId, firstTs, lastTs, count, skippedLineCount }
}
