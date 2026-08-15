import { stat } from 'node:fs/promises'
import type { SqliteHandle } from '../store/sqlite.js'
import { journalDbPathFor, openJournalDbShared } from './db.js'
import { dbHasSession } from './db-read.js'
import type { CrossSessionSearchOptions, CrossSessionSearchResult } from './search.js'

/**
 * How the journal's two read carriers are chosen between and, when both
 * answer, how one caller's budget is split across them (M4.5 wave 4,
 * decision 5). The SQL is in `db-read.ts`, the file walks stay in
 * `search.ts`/`reader.ts`/`index-cache.ts`; this module holds only the part
 * both arms have to agree on, so the three entry points express the same rule
 * once instead of three times.
 *
 * The rule, per journal directory:
 * - no `journal.db` on disk → the file arm alone, exactly as before. A read
 *   must never CREATE the database: an empty one would answer "yes, I am the
 *   carrier" for every future routing check and silence a pure-legacy
 *   install's journal;
 * - `journal.db` present → a session it holds (rows, or an import marker) is
 *   its; a session that exists only as a `*.jsonl` file is still the file
 *   arm's; listings merge both.
 *
 * On a session id present in both carriers the database wins. Session ids are
 * per-run ULIDs, so a collision cannot arise from this plane's own writes —
 * the rule exists to make the merge total, and is documented rather than
 * defended in code.
 */

/**
 * The journal directory's database, or null when the directory has none.
 *
 * The `stat` probe is the whole point: `openJournalDbShared` would create the
 * file, and a read has no business doing that. A directory that cannot be
 * probed at all (a permission error, say) is a real failure and propagates —
 * quietly falling back to the file arm would present half a journal as the
 * whole one.
 */
export async function openJournalDbIfPresent(journalDir: string): Promise<SqliteHandle | null> {
  const dbPath = journalDbPathFor(journalDir)
  try {
    await stat(dbPath)
  } catch (error: unknown) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
  return openJournalDbShared(dbPath)
}

function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Predicate the file arms filter through: true for a session the database is
 * the carrier for, and so one the file arm must stay silent about even when a
 * legacy `*.jsonl` for it is still lying around (a cold backup after an
 * import). Without a database nothing is shadowed.
 */
export function isShadowedByDb(handle: SqliteHandle | null): (sessionId: string) => boolean {
  if (handle === null) {
    return () => false
  }
  return (sessionId: string) => dbHasSession(handle, sessionId)
}

/** The resolved ceilings of ONE cross-session search, shared by both arms. */
export interface CrossSessionCeilings {
  readonly hitLimit: number
  readonly maxFiles: number
  readonly maxBytes: number
  readonly deadlineAt: number
}

/** What an arm has already spent out of those ceilings. */
export interface CrossSessionSpend {
  readonly hits: readonly unknown[]
  readonly filesScanned: number
  readonly bytesRead: number
}

/** Nothing spent yet — the first arm's starting point. */
export const NO_SPEND: CrossSessionSpend = { hits: [], filesScanned: 0, bytesRead: 0 }

/**
 * The options the next arm runs under: the caller's, with every ceiling
 * reduced by what the previous arm consumed.
 *
 * Said plainly, because the alternative reading is the wrong one: the
 * ceilings apply PER ARM sequentially, and the subtraction is what keeps
 * their sum inside the caller's ask. Two arms therefore never open more than
 * `maxFiles` sessions, never read more than `maxBytes`, and share one
 * wall-clock deadline rather than getting a fresh budget each.
 *
 * A `limit` of zero (the first arm already filled the page) is deliberate and
 * harmless: the walk clamps it to one, so the second arm collects at most one
 * hit past the page — which is exactly the evidence `hasMore`/`truncated`
 * needs, and the merge drops the hit itself.
 */
export function armOptions(
  options: CrossSessionSearchOptions,
  ceilings: CrossSessionCeilings,
  spent: CrossSessionSpend,
  nowMs: number,
): CrossSessionSearchOptions {
  return {
    ...options,
    limit: Math.max(0, ceilings.hitLimit - spent.hits.length),
    maxFiles: Math.max(0, ceilings.maxFiles - spent.filesScanned),
    maxBytes: Math.max(0, ceilings.maxBytes - spent.bytesRead),
    timeBudgetMs: Math.max(0, ceilings.deadlineAt - nowMs),
  }
}

/**
 * One answer out of two arms' answers. Hits keep arm order (database first,
 * newest-first within each) and are cut to the caller's page; the counters
 * add up, because they describe one search's cost however it was paid; and
 * the stop reason is the first arm's if it had one, since the second only
 * ever runs when the first finished.
 */
export function mergeCrossSessionResults(
  first: CrossSessionSearchResult,
  second: CrossSessionSearchResult,
  hitLimit: number,
): CrossSessionSearchResult {
  const stoppedBy = first.stoppedBy ?? second.stoppedBy
  return {
    hits: [...first.hits, ...second.hits].slice(0, hitLimit),
    truncated: stoppedBy !== null,
    stoppedBy,
    filesScanned: first.filesScanned + second.filesScanned,
    filesTotal: first.filesTotal + second.filesTotal,
    bytesRead: first.bytesRead + second.bytesRead,
    skippedLineCount: first.skippedLineCount + second.skippedLineCount,
  }
}
