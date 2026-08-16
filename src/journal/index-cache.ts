import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import { openJournalDbIfPresent } from './db.js'
import { dbSessionLastSeqs, type DbSessionLastSeq, type DbSessionSummary } from './db-read.js'
import { dbSessionLastSeqFor, dbSessionSummaryFor } from './db-read-session.js'
import { assertValidSessionId } from './session-id.js'
import type { SqliteHandle } from '../store/sqlite.js'

/**
 * In-memory summary cache for the session list (M4.5 wave 5: rebuilt on the
 * database's own freshness, closing wave-4 Issue 3 — `listSessions()`
 * re-running an O(rows) aggregate on every UI refresh).
 *
 * The read side is DB-only since the wave-5 cutover: `dbSessionSummaryFor` is
 * already one indexed `GROUP BY` per session, cheap enough on its own that
 * caching its ANSWER buys nothing. What this cache avoids is re-running that
 * query for a session that has not written since the page was last drawn —
 * the problem a UI an operator refreshes has and a one-shot CLI print does
 * not.
 *
 * Freshness token: a session's highest `seq` (`MAX(seq)`), the DB analogue of
 * a file's mtime — monotonic (`AUTOINCREMENT`, never reused), cheap to read
 * (`idx_journal_session_seq` answers it without a table scan), and unlike
 * mtime it cannot lie about "changed vs not" (no same-length rewrite, no
 * restored timestamp). A cache entry is stale on ANY difference in `lastSeq`,
 * not just an increase: a session whose rows were later pruned (M5
 * retention) has a LOWER `lastSeq` than what is cached, and must still
 * re-summarize — hence inequality, never `>`, in `takeFresh` below.
 *
 * Deliberately not persisted, same as before the cutover: a cache on disk
 * would be a second place claiming to know what `journal.db` says, and this
 * one is rebuildable in the time it takes to run the queries once.
 */

/** Cached summary of one session. */
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
  /** Every session in `dir`, newest write first; a missing database yields []. */
  readonly listSessions: (dir?: string) => Promise<readonly SessionSummaryEntry[]>
  /** One session's summary, or null when the database holds no row for it. */
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

/**
 * The database read seam, injectable so a test can count calls instead of
 * touching a real database — the counting seam the file arm's
 * `JournalReadDeps` gave this module's tests before the cutover.
 */
export interface SessionIndexCacheDeps {
  readonly openDb: (dir: string) => Promise<SqliteHandle | null>
  readonly lastSeqs: (handle: SqliteHandle) => readonly DbSessionLastSeq[]
  readonly lastSeqFor: (handle: SqliteHandle, sessionId: string) => number | null
  readonly summaryFor: (handle: SqliteHandle, sessionId: string) => DbSessionSummary | null
}

const defaultDeps: SessionIndexCacheDeps = {
  openDb: openJournalDbIfPresent,
  lastSeqs: dbSessionLastSeqs,
  lastSeqFor: dbSessionLastSeqFor,
  summaryFor: dbSessionSummaryFor,
}

interface CachedSummary {
  readonly lastSeq: number
  readonly summary: SessionSummaryEntry
}

/**
 * Creates a summary cache. `deps` overrides the real database reads — a test
 * seam, never used by production wiring (`ui-wiring.ts` calls this with no
 * arguments).
 */
export function createSessionIndexCache(
  deps: Partial<SessionIndexCacheDeps> = {},
  options: SessionIndexCacheOptions = {},
): SessionIndexCache {
  const resolved: SessionIndexCacheDeps = { ...defaultDeps, ...deps }
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_CACHED_SESSIONS)
  const cache = new Map<string, CachedSummary>()

  /** `listSessions` and `getSession` share one cache keyed by directory + session. */
  function keyFor(dir: string, sessionId: string): string {
    return join(dir, sessionId)
  }

  function cachedSummaryFor(
    handle: SqliteHandle,
    key: string,
    sessionId: string,
    lastSeq: number,
  ): SessionSummaryEntry | null {
    const fresh = takeFresh(cache, key, lastSeq)
    if (fresh !== undefined) {
      return fresh.summary
    }
    const summary = resolved.summaryFor(handle, sessionId)
    if (summary === null) {
      cache.delete(key)
      return null
    }
    store(cache, key, { lastSeq, summary }, maxEntries)
    return summary
  }

  /**
   * Order is the query's own — newest write first — and is returned as-is,
   * without a re-sort: `lastSeq` is already a total order (see
   * `SELECT_SESSION_LAST_SEQ` in `db-read.ts`), the DB analogue of the file
   * arm's mtime order.
   */
  async function listSessions(dir: string = JOURNAL_DIR): Promise<readonly SessionSummaryEntry[]> {
    const handle = await resolved.openDb(dir)
    if (handle === null) {
      return []
    }
    const summaries = resolved
      .lastSeqs(handle)
      .map((entry) => cachedSummaryFor(handle, keyFor(dir, entry.sessionId), entry.sessionId, entry.lastSeq))
    return summaries.filter((entry): entry is SessionSummaryEntry => entry !== null)
  }

  async function getSession(
    sessionId: string,
    dir: string = JOURNAL_DIR,
  ): Promise<SessionSummaryEntry | null> {
    assertValidSessionId(sessionId)
    const handle = await resolved.openDb(dir)
    if (handle === null) {
      return null
    }
    const key = keyFor(dir, sessionId)
    const lastSeq = resolved.lastSeqFor(handle, sessionId)
    if (lastSeq === null) {
      cache.delete(key)
      return null
    }
    return cachedSummaryFor(handle, key, sessionId, lastSeq)
  }

  function invalidate(sessionId: string, dir: string = JOURNAL_DIR): void {
    assertValidSessionId(sessionId)
    cache.delete(keyFor(dir, sessionId))
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
 * Returns the cached entry when its `lastSeq` still matches, marking it most
 * recently used. Any difference is a miss, not just a lower cached value —
 * see the module doc for why "greater than" would be the wrong test.
 */
function takeFresh(
  cache: Map<string, CachedSummary>,
  key: string,
  lastSeq: number,
): CachedSummary | undefined {
  const cached = cache.get(key)
  if (cached === undefined || cached.lastSeq !== lastSeq) {
    return undefined
  }
  cache.delete(key)
  cache.set(key, cached)
  return cached
}

/** Inserts an entry as most recently used, evicting the oldest past the cap. */
function store(
  cache: Map<string, CachedSummary>,
  key: string,
  entry: CachedSummary,
  maxEntries: number,
): void {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next()
    if (oldest.done === true) {
      return
    }
    cache.delete(oldest.value)
  }
}
