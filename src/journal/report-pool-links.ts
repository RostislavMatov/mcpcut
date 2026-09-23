import type { SqliteHandle } from '../store/sqlite.js'
import { parseJournalLine } from './line-source.js'
import { readPoolPayload } from './report-pools.js'

/**
 * Which pool sessions attached a session that is exported ALONE (ADR-0015
 * amendment 2026-09-23, D2, EX1): `export --report --session <child>` holds
 * the child's records only, and the pool records that name it live in the
 * pool sessions' own. Found here so `summary.md` can say which pool, agent
 * and server the child belonged to — with an explicit note that these lines
 * come from records OUTSIDE the export.
 *
 * Read from the SAME snapshot as the export: the caller runs this inside the
 * `withConsistentReadView` the stream already holds (the CRITICAL of M5
 * wave 5 — everything a report claims describes one state of the journal).
 *
 * The walk goes through the indexes, never a full scan: a recursive CTE hops
 * from one distinct `session_id` to the next (`db-read.ts`), and for each it
 * seeks the session's `kind = 'pool'` rows through `idx_journal_session_kind`.
 * `instr(doc, ?)` is only a pre-filter: every row it lets through is parsed
 * and read by the same reader the export's own pool ledger uses, and counts
 * only as an `attach` whose `childSessionId` IS the exported session. A row
 * that mentions the id anywhere else (a `reason`, a tool name) counts for
 * nothing.
 *
 * Bounded for a hostile journal: at most {@link MAX_POOL_LINK_SCAN_ROWS} rows
 * looked at, at most {@link MAX_POOL_LINKS_PER_SESSION} links kept, and what
 * lies past either bound is COUNTED, never silently dropped.
 */

/** Links kept for one exported session; the rest are counted. */
export const MAX_POOL_LINKS_PER_SESSION = 16

/** Pre-filtered rows looked at, matching or not, before the lookup stops. */
export const MAX_POOL_LINK_SCAN_ROWS = 1000

export interface ReportOutsideLink {
  readonly poolSessionId: string
  readonly agentName: string
  readonly serverName: string
  /** `ts` of the `attach` record. */
  readonly attachedAt: string
  readonly seq: number
  readonly lifetime?: string
}

export interface ReportOutsideLinks {
  readonly links: readonly ReportOutsideLink[]
  /** Links found past {@link MAX_POOL_LINKS_PER_SESSION}. */
  readonly omittedCount: number
  /** Pre-filtered pool rows whose doc or payload could not be read. */
  readonly unreadableCount: number
  /** The lookup stopped at {@link MAX_POOL_LINK_SCAN_ROWS}: there may be more. */
  readonly isScanCapped: boolean
}

export const NO_OUTSIDE_LINKS: ReportOutsideLinks = Object.freeze({
  links: Object.freeze([]),
  omittedCount: 0,
  unreadableCount: 0,
  isScanCapped: false,
})

/** The lookup, exported so its query plan can be asserted on the very statement run. */
export const SELECT_POOL_ROWS_NAMING_SESSION =
  'WITH RECURSIVE distinct_sessions(session_id) AS (' +
  'SELECT MIN(session_id) FROM journal_records ' +
  'UNION ALL ' +
  'SELECT (SELECT MIN(r.session_id) FROM journal_records r WHERE r.session_id > d.session_id) ' +
  'FROM distinct_sessions d WHERE d.session_id IS NOT NULL) ' +
  'SELECT r.seq AS seq, r.session_id AS sessionId, r.doc AS doc ' +
  'FROM distinct_sessions d JOIN journal_records r ' +
  "ON r.session_id = d.session_id AND r.kind = 'pool' " +
  'WHERE d.session_id IS NOT NULL AND d.session_id <> ? AND instr(r.doc, ?) > 0 ' +
  'ORDER BY r.seq LIMIT ?'

interface LinkRow {
  readonly seq: number
  readonly sessionId: string
  readonly doc: string
}

export function poolLinksOutsideExport(handle: SqliteHandle, sessionId: string): ReportOutsideLinks {
  const rows = handle.db
    .prepare(SELECT_POOL_ROWS_NAMING_SESSION)
    .all(sessionId, sessionId, MAX_POOL_LINK_SCAN_ROWS + 1) as unknown as LinkRow[]
  const links: ReportOutsideLink[] = []
  let omittedCount = 0
  let unreadableCount = 0
  for (const row of rows.slice(0, MAX_POOL_LINK_SCAN_ROWS)) {
    const link = linkOf(row, sessionId)
    if (link === 'unreadable') {
      unreadableCount += 1
    } else if (link !== null) {
      if (links.length < MAX_POOL_LINKS_PER_SESSION) links.push(link)
      else omittedCount += 1
    }
  }
  return Object.freeze({
    links: Object.freeze(links),
    omittedCount,
    unreadableCount,
    isScanCapped: rows.length > MAX_POOL_LINK_SCAN_ROWS,
  })
}

/** The link one row states, `null` when it states none, `'unreadable'` when it cannot be read. */
function linkOf(row: LinkRow, sessionId: string): ReportOutsideLink | null | 'unreadable' {
  const record = parseJournalLine(row.doc)
  if (record === null || record.kind !== 'pool' || record.sessionId !== row.sessionId) return 'unreadable'
  const payload = readPoolPayload(record.payload)
  if (payload === null) return 'unreadable'
  if (payload.event !== 'attach' || payload.childSessionId !== sessionId) return null
  return {
    poolSessionId: row.sessionId,
    agentName: payload.agentName,
    serverName: payload.serverName ?? '',
    attachedAt: record.ts,
    seq: row.seq,
    ...(payload.lifetime === undefined ? {} : { lifetime: payload.lifetime }),
  }
}
