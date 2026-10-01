import type { SqliteHandle } from '../store/sqlite.js'
import { textOf } from './db-row.js'

/**
 * Which server and which agent a session belongs to, read for the `sessions`
 * list. Presentation only: nothing is stored for this, the answer comes out of
 * records the journal already holds.
 *
 * - server: the first `decision` record's `serverName` (every `wrap` and
 *   `connect` child session stamps it); a pool session has no decision of its
 *   own, so its `open` record's `members` stand in.
 * - agent: the first decision's `agentName` (stamped on every decision of an
 *   agent's session, absent on `wrap`), else the pool record's `agentName`.
 *   Decisions written before 2026-09-18 carry it only on some rows; a session
 *   whose first decision lacks it reads as unknown.
 *
 * Cost: one indexed lookup per session (`idx_journal_session_kind`) that
 * parses a single `doc` each, not a scan of the journal.
 */
const SELECT_SESSION_ORIGINS =
  'SELECT s.session_id AS sessionId, ' +
  "(SELECT json_extract(r.doc, '$.decision.serverName') FROM journal_records r " +
  "WHERE r.session_id = s.session_id AND r.kind = 'decision' ORDER BY r.seq LIMIT 1) AS decisionServer, " +
  "(SELECT json_extract(r.doc, '$.decision.agentName') FROM journal_records r " +
  "WHERE r.session_id = s.session_id AND r.kind = 'decision' ORDER BY r.seq LIMIT 1) AS decisionAgent, " +
  "(SELECT json_extract(r.doc, '$.payload.agentName') FROM journal_records r " +
  "WHERE r.session_id = s.session_id AND r.kind = 'pool' ORDER BY r.seq LIMIT 1) AS poolAgent, " +
  "(SELECT json_extract(r.doc, '$.payload.members') FROM journal_records r " +
  "WHERE r.session_id = s.session_id AND r.kind = 'pool' AND json_type(r.doc, '$.payload.members') = 'array' " +
  'ORDER BY r.seq LIMIT 1) AS poolMembers ' +
  'FROM (SELECT DISTINCT session_id FROM journal_records) s'

export interface SessionOrigin {
  readonly serverName?: string
  readonly agentName?: string
}

/** Server and agent per session id; a session with neither is left out. */
export function dbSessionOrigins(handle: SqliteHandle): ReadonlyMap<string, SessionOrigin> {
  const entries = handle.db
    .prepare(SELECT_SESSION_ORIGINS)
    .all()
    .map((row): readonly [string, SessionOrigin] => {
      const serverName = textOf(row['decisionServer']) || membersOf(row['poolMembers'])
      const agentName = textOf(row['decisionAgent']) || textOf(row['poolAgent'])
      return [
        textOf(row['sessionId']),
        {
          ...(serverName !== '' ? { serverName } : {}),
          ...(agentName !== '' ? { agentName } : {}),
        },
      ]
    })
  return new Map(entries)
}

/** `["fs","github"]` (json_extract's text form of an array) as `fs,github`; anything else as empty. */
function membersOf(value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string').join(',') : ''
  } catch {
    return ''
  }
}
