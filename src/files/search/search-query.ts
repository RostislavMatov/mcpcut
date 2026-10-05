import { isWithinOn, lexicalKey, pathModuleOf, segmentCount } from '../names.js'
import { resolveWithinRoots } from '../paths.js'
import { isAllowed, type FileRule, type PreparedRule } from '../rights.js'
import { pathMatchKey } from '../db/path-key.js'
import { SEARCH_MAX_PAGES, SEARCH_OVERFETCH } from './constants.js'
import { absoluteOf } from './index-plan.js'
import type { SearchDb } from './search-schema.js'

/**
 * The query behind `search_files` (ADR-0020 §2, §6). The SQL narrows the
 * candidates to files under a rule that lets the agent read; the run-time
 * rights check then decides, on every row, with the same code `read_file`
 * uses. A row the SQL let through and the check refuses is dropped, so a
 * result never comes from a file the agent cannot read.
 */

/** One rule of the agent as the SQL sees it. */
export interface RuleKey {
  readonly key: string
  /** `key` plus the separator (not doubled when the key already ends with it): what a descendant starts with. */
  readonly prefix: string
  readonly depth: number
  readonly can_read: boolean
}

export function prefixOf(key: string, platform: NodeJS.Platform): string {
  const sep = pathModuleOf(platform).sep
  return key.endsWith(sep) ? key : `${key}${sep}`
}

/** Rules on one folder merged like `opsAt` merges them: ops add up, an empty rule wins the tie. */
export function ruleKeysOf(rules: readonly FileRule[], platform: NodeJS.Platform): readonly RuleKey[] {
  const byKey = new Map<string, { canRead: boolean; isCutOut: boolean }>()
  for (const rule of rules) {
    const key = pathMatchKey(rule.path, platform)
    const seen = byKey.get(key) ?? { canRead: false, isCutOut: false }
    byKey.set(key, { canRead: seen.canRead || rule.ops.includes('read'), isCutOut: seen.isCutOut || rule.ops.length === 0 })
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, seen]) => ({ key, prefix: prefixOf(key, platform), depth: segmentCount(key), can_read: seen.canRead && !seen.isCutOut }))
}

/** $1 rules, $2 roots, $3 the `under` key, $4 the `under` prefix: the same four parameters for the search and the count. */
const READABLE_FILTER = `
CROSS JOIN LATERAL (
  SELECT r.can_read FROM jsonb_to_recordset($1::jsonb) AS r(key text, prefix text, depth int, can_read boolean)
  WHERE f.path_key = r.key OR starts_with(f.path_key, r.prefix)
  ORDER BY r.depth DESC LIMIT 1
) AS best
WHERE best.can_read AND f.status = 'indexed' AND f.root = ANY($2::text[])
  AND ($3::text IS NULL OR f.path_key = $3 OR starts_with(f.path_key, $4))`

function searchSql(vectorSchema: string): string {
  return `SELECT f.root, f.rel_path, c.start_line, c.end_line, c.body,
       c.embedding OPERATOR(${vectorSchema}.<=>) $5::${vectorSchema}.vector AS distance
FROM search_chunks c JOIN search_files f USING (root, rel_path)${READABLE_FILTER}
ORDER BY distance, c.root, c.rel_path, c.chunk_no
LIMIT $6 OFFSET $7`
}

const COUNT_SQL = `SELECT 1 AS found FROM search_files f${READABLE_FILTER}
LIMIT 1`

export interface SearchScope {
  readonly roots: readonly string[]
  /** The agent's rules: they narrow the SQL. */
  readonly rules: readonly FileRule[]
  /** The same rules, freshly prepared: they decide on every row. */
  readonly prepared: readonly PreparedRule[]
  /** Only files under this folder (an absolute path that already passed the read check). */
  readonly under?: string
  readonly platform: NodeJS.Platform
}

function scopeParams(scope: SearchScope): readonly unknown[] {
  const underKey = scope.under === undefined ? null : pathMatchKey(scope.under, scope.platform)
  return [
    JSON.stringify(ruleKeysOf(scope.rules, scope.platform)),
    [...scope.roots],
    underKey,
    underKey === null ? null : prefixOf(underKey, scope.platform),
  ]
}

export interface SearchHit {
  /** Absolute path of the file. */
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly body: string
  readonly distance: number
}

export interface SearchRequest extends SearchScope {
  readonly vector: Float32Array
  readonly limit: number
}

interface Row {
  readonly root: string
  readonly rel_path: string
  readonly start_line: number
  readonly end_line: number
  readonly body: string
  readonly distance: number | string
}

/** The row's file, when the run-time check agrees the agent may read it (and it lies under `under`). */
async function checkedPath(row: Row, scope: SearchScope): Promise<string | null> {
  const absolute = absoluteOf(row.root, row.rel_path, scope.platform)
  const resolved = await resolveWithinRoots(absolute, scope.roots)
  if (!resolved.ok || !resolved.path.exists || !isAllowed(resolved.path, 'read', scope.prepared)) return null
  if (scope.under !== undefined) {
    const key = (value: string): string => lexicalKey(value, scope.platform)
    if (!isWithinOn(key(scope.under), key(resolved.path.absolute), scope.platform)) return null
  }
  return absolute
}

/**
 * The best passages among the files the agent may read, nearest first. A file
 * reachable through two nested roots shows once per passage, with its best score.
 */
export async function searchChunks(sdb: SearchDb, request: SearchRequest): Promise<readonly SearchHit[]> {
  const vectorText = `[${Array.from(request.vector).join(',')}]`
  const pageSize = request.limit * SEARCH_OVERFETCH
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  for (let page = 0; page < SEARCH_MAX_PAGES && hits.length < request.limit; page += 1) {
    const found = await sdb.db.query<Row>(searchSql(sdb.vectorSchema), [...scopeParams(request), vectorText, pageSize, page * pageSize])
    await collectHits(found.rows, request, seen, hits)
    if (found.rows.length < pageSize) break
  }
  return hits
}

/** Adds the rows that pass the run-time check and are not repeats, until `limit` hits are held. */
async function collectHits(rows: readonly Row[], request: SearchRequest, seen: Set<string>, hits: SearchHit[]): Promise<void> {
  for (const row of rows) {
    if (hits.length >= request.limit) return
    const path = await checkedPath(row, request)
    if (path === null) continue
    const id = `${pathMatchKey(path, request.platform)}\u0000${row.start_line}-${row.end_line}`
    if (seen.has(id)) continue
    seen.add(id)
    hits.push({ path, startLine: row.start_line, endLine: row.end_line, body: row.body, distance: Number(row.distance) })
  }
}

/** True when the SQL filter sees at least one indexed file the agent may read: tells "nothing indexed" from "nothing matched". */
export async function hasReadableIndexed(sdb: SearchDb, scope: SearchScope): Promise<boolean> {
  const found = await sdb.db.query(COUNT_SQL, scopeParams(scope))
  return found.rows.length > 0
}
