import { MAX_PAGE_LIMIT } from '../../journal/search.js'
import type { FileAuditActor, FileAuditEntry, FileAuditQuery, FileAuditResult, FileAuditSubject } from '../audit.js'
import { pathModuleOf } from '../names.js'
import type { FilesDb } from './connection.js'
import { ancestorKeys, descendantRange, pathMatchKey } from './path-key.js'

/**
 * `queryFileAudit` over the Postgres index (ADR-0020 §5, §6): same question,
 * same answer, from an indexed table — complete, no walk budget. The path
 * match mirrors `pathMatcher` of the journal walk: an entry matches when it
 * touched a query spelling or something inside it, or — for a whole-tree
 * action — a folder holding it.
 */

const MIN_LIMIT = 1

interface EventRow {
  readonly ts: string
  readonly session_id: string
  readonly record_id: string
  readonly actor_kind: string
  readonly actor_name: string | null
  readonly actor_via: string | null
  readonly action: string
  readonly outcome: string | null
  readonly rule: string | null
  readonly subject_kind: string | null
  readonly subject_name: string | null
  readonly paths: readonly string[]
}

type Params = readonly unknown[]

/** One `EXISTS` over `file_event_paths` for the whole query: every spelling is an alternative. */
function pathCondition(spellings: readonly string[], platform: NodeJS.Platform, params: Params): { sql: string; params: Params } | undefined {
  const isAbsolute = pathModuleOf(platform).isAbsolute
  const keys = spellings.filter((value) => isAbsolute(value)).map((value) => pathMatchKey(value, platform))
  if (keys.length === 0) return { sql: 'FALSE', params }
  const alternatives: string[] = []
  let next = params
  for (const key of keys) {
    const range = descendantRange(key, platform)
    const base = next.length
    next = [...next, key, range.from, range.to, ancestorKeys(key, platform)]
    alternatives.push(
      `(p.path_key = $${base + 1} OR (p.path_key >= $${base + 2} AND p.path_key < $${base + 3}) ` +
        `OR (p.is_tree AND p.path_key = ANY($${base + 4}::text[])))`,
    )
  }
  return {
    sql: `EXISTS (SELECT 1 FROM file_event_paths p WHERE p.journal_seq = e.journal_seq AND (${alternatives.join(' OR ')}))`,
    params: next,
  }
}

function entryOf(row: EventRow): FileAuditEntry {
  const actor: FileAuditActor =
    row.actor_kind === 'admin'
      ? { kind: 'admin', name: row.actor_name ?? '', via: row.actor_via ?? '' }
      : { kind: 'agent', name: row.actor_name }
  const subject: FileAuditSubject | null =
    row.subject_kind === null || row.subject_name === null ? null : { kind: row.subject_kind as FileAuditSubject['kind'], name: row.subject_name }
  return {
    ts: row.ts,
    sessionId: row.session_id,
    recordId: row.record_id,
    actor,
    action: row.action,
    outcome: row.outcome,
    rule: row.rule,
    subject,
    paths: row.paths,
  }
}

export async function queryFileAuditDb(db: FilesDb, query: FileAuditQuery, platform: NodeJS.Platform): Promise<FileAuditResult> {
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(MIN_LIMIT, Math.floor(query.limit)))
  const conditions: string[] = []
  let params: Params = []
  if (query.path !== undefined) {
    const found = pathCondition([query.path, ...(query.pathAliases ?? [])], platform, params)
    if (found !== undefined) {
      conditions.push(found.sql)
      params = found.params
    }
  }
  if (query.agent !== undefined) {
    params = [...params, query.agent]
    conditions.push(`e.agent_key = $${params.length}`)
  }
  if (query.since !== undefined) {
    params = [...params, query.since]
    conditions.push(`e.ts >= $${params.length}`)
  }
  params = [...params, limit + 1]
  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')} `
  const found = await db.query<EventRow>(
    `SELECT e.* FROM file_events e ${where}ORDER BY e.ts DESC, e.record_id DESC LIMIT $${params.length}`,
    params,
  )
  return { entries: found.rows.slice(0, limit).map(entryOf), hasMore: found.rows.length > limit, truncated: false }
}
