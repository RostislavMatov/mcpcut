import { openJournalDbIfPresent } from '../journal/db.js'
import { epochMsOf, textOf } from '../journal/db-row.js'
import { parseJournalLine } from '../journal/line-source.js'
import type { JournalRecord } from '../journal/record.js'

/**
 * The passive half of a server's status (M5.5 p.1, O1): "when did this server
 * last serve a call the plane actually let through?", answered from the
 * journal's decision records alone — no probe, no traffic of its own.
 *
 * `journal_records` deliberately has no server column (plan finding 4: adding
 * one would touch the chain and the export for the sake of a signal a scan
 * can carry), so the answer comes from a bounded newest-first walk over `doc`
 * texts, in the spirit of `journal/search-limits.ts`: read at most
 * `maxScannedRows` rows, stop at the first hit, and never let one page render
 * cost what the table weighs. A short in-memory cache in front of the walk
 * keeps repeated renders from rescanning at all.
 *
 * Thresholds arrive as options, not imports: `src/probe/constants.ts` is a
 * parallel task's file, and the orchestrator wires its `STATUS_STALE_AFTER_MS`
 * through `freshAfterMs` when it composes the tracker.
 */

/** Activity older than this is no longer "fresh" — the passive-signal horizon (O2's ~1 hour). */
export const DEFAULT_ACTIVITY_FRESH_AFTER_MS = 60 * 60 * 1000

/** How long one scanned answer is served from memory before the journal is consulted again. */
export const DEFAULT_ACTIVITY_CACHE_TTL_MS = 15_000

/**
 * Rows one scan may read, newest first. The ceiling bounds what SQLite walks
 * (`LIMIT` in the query, not a filter after it), so a journal that holds no
 * decisions at all still costs at most this many row reads. A success buried
 * deeper than the newest 20k records is beyond any freshness window this
 * signal serves; the active probe answers for such a server instead.
 */
export const DEFAULT_ACTIVITY_MAX_SCANNED_ROWS = 20_000

/**
 * Outcomes that mean the call actually went through to the server: a plain
 * policy `allow` and a human `approved`. Everything else — `deny`,
 * `denied-by-operator`, `timeout`, `quarantined`, `require-approval-pending` —
 * proves the AGENT was active, not that the server answered anything.
 */
const SUCCESSFUL_OUTCOMES: ReadonlySet<string> = new Set(['allow', 'approved'])

/**
 * Newest rows first, ceiling enforced by the database: `seq` is the primary
 * key, so this is a bounded backward index walk, never a full-table scan.
 * `kind` rides along so non-decision rows are skipped without a JSON parse.
 */
const SELECT_NEWEST_ROWS = 'SELECT doc, kind FROM journal_records ORDER BY seq DESC LIMIT ?'

/** What the journal passively says about one server. */
export interface ServerActivity {
  /** Timestamp (ISO-8601 UTC) of the newest allowed/approved decision for the server. */
  readonly lastActivityAt: string
  /** True while that activity is younger than the freshness threshold. */
  readonly fresh: boolean
}

export interface ActivityTrackerOptions {
  /** The journal directory holding `journal.db` (`state.db`'s sibling). */
  readonly journalDir: string
  /** Freshness horizon; defaults to one hour. */
  readonly freshAfterMs?: number
  /** In-memory cache lifetime; defaults to `DEFAULT_ACTIVITY_CACHE_TTL_MS`. */
  readonly cacheTtlMs?: number
  /** Scan ceiling; defaults to `DEFAULT_ACTIVITY_MAX_SCANNED_ROWS`. */
  readonly maxScannedRows?: number
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number
  /** Observer for rows one scan actually read — the tests' cost meter. */
  readonly onRowsScanned?: (rowsScanned: number) => void
}

export interface ActivityTracker {
  /**
   * The server's last successful activity, or null when the journal holds
   * none within the scan ceiling (including a missing or empty `journal.db`
   * — an unused installation is a normal state, not an error).
   */
  readonly lastSuccessfulActivity: (serverName: string) => Promise<ServerActivity | null>
}

/** One remembered scan: when it ran and what it found (null is a finding too). */
interface CacheEntry {
  readonly cachedAtMs: number
  readonly lastActivityAt: string | null
}

/** Creates a tracker with a per-server cache; one instance per process is the intent. */
export function createActivityTracker(options: ActivityTrackerOptions): ActivityTracker {
  const now = options.now ?? Date.now
  const freshAfterMs = options.freshAfterMs ?? DEFAULT_ACTIVITY_FRESH_AFTER_MS
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_ACTIVITY_CACHE_TTL_MS
  const maxScannedRows = options.maxScannedRows ?? DEFAULT_ACTIVITY_MAX_SCANNED_ROWS
  const cache = new Map<string, CacheEntry>()

  async function lastSuccessfulActivity(serverName: string): Promise<ServerActivity | null> {
    const nowMs = now()
    const cached = cache.get(serverName)
    if (cached !== undefined && nowMs - cached.cachedAtMs < cacheTtlMs) {
      // The timestamp is cached; freshness is not — it decays in real time,
      // so it is recomputed against the current clock on every read.
      return toActivity(cached.lastActivityAt, nowMs, freshAfterMs)
    }
    const lastActivityAt = await scanNewestDecisions(options, serverName, maxScannedRows)
    cache.set(serverName, { cachedAtMs: nowMs, lastActivityAt })
    return toActivity(lastActivityAt, nowMs, freshAfterMs)
  }

  return { lastSuccessfulActivity }
}

/** Wraps a found timestamp into the caller-facing shape; null stays null. */
function toActivity(
  lastActivityAt: string | null,
  nowMs: number,
  freshAfterMs: number,
): ServerActivity | null {
  if (lastActivityAt === null) {
    return null
  }
  return { lastActivityAt, fresh: nowMs - epochMsOf(lastActivityAt) <= freshAfterMs }
}

/**
 * Walks the newest rows for the server's most recent successful decision.
 * Stops at the first hit — rows arrive newest-first, so the first match IS
 * the answer — or at the ceiling. Malformed rows are skipped, never fatal:
 * this is a convenience signal, not the evidence path (`verify` owns that).
 */
async function scanNewestDecisions(
  options: ActivityTrackerOptions,
  serverName: string,
  maxScannedRows: number,
): Promise<string | null> {
  const handle = await openJournalDbIfPresent(options.journalDir)
  if (handle === null) {
    return null
  }
  let rowsScanned = 0
  let found: string | null = null
  for (const row of handle.db.prepare(SELECT_NEWEST_ROWS).iterate(maxScannedRows)) {
    rowsScanned += 1
    if (textOf(row['kind']) !== 'decision') {
      continue
    }
    const ts = successfulActivityTsOf(parseJournalLine(textOf(row['doc'])), serverName)
    if (ts !== null) {
      found = ts
      break
    }
  }
  options.onRowsScanned?.(rowsScanned)
  return found
}

/** The record's timestamp iff it is a successful decision for `serverName`. */
function successfulActivityTsOf(record: JournalRecord | null, serverName: string): string | null {
  if (record === null || record.kind !== 'decision' || record.decision === undefined) {
    return null
  }
  const { decision } = record
  const isMatch =
    decision.serverName === serverName && SUCCESSFUL_OUTCOMES.has(decision.outcome)
  // A timestamp that does not parse cannot answer "how long ago", so the row
  // cannot serve as the freshness anchor; older rows still can.
  return isMatch && !Number.isNaN(epochMsOf(record.ts)) ? record.ts : null
}
