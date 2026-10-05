import { createPool } from '../db/connection.js'
import { mapPgError } from '../db/errors.js'
import type { PgModule } from '../db/pg-types.js'
import { pathMatchKey } from '../db/path-key.js'
import { isWithinOn, segmentCount } from '../names.js'
import { loadCatalogFiles, loadIndexRows } from './index-store.js'
import { planIndex, absoluteOf } from './index-plan.js'
import type { IndexRule } from './index-rules-store.js'

/**
 * Read-only counts of the search index for `files index list` and `files db
 * status`. Like `readDbStatus` these never migrate and never create anything:
 * a database without the search tables answers `undefined`.
 */

export interface SearchTarget {
  readonly pg: PgModule
  readonly url: string
  readonly schema: string
  readonly cli: string
}

export interface SearchTotals {
  readonly indexed: number
  readonly chunks: number
  readonly skipped: number
  /** ISO time of the newest `indexed_at`, or `null` when nothing was indexed. */
  readonly lastIndexedAt: string | null
}

export interface RuleCounts {
  readonly indexed: number
  readonly chunks: number
  readonly skipped: number
  readonly pending: number
}

const HAS_TABLES = "SELECT to_regclass('search_files') IS NOT NULL AS present"
const TOTALS =
  "SELECT count(*) FILTER (WHERE status = 'indexed') AS indexed, coalesce(sum(chunks) FILTER (WHERE status = 'indexed'), 0) AS chunks, " +
  "count(*) FILTER (WHERE status = 'skipped') AS skipped, to_char(max(indexed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS last FROM search_files"

async function withPool<T>(target: SearchTarget, fn: (pool: ReturnType<typeof createPool>) => Promise<T>): Promise<T> {
  const pool = createPool(target.pg, target.url, target.schema)
  try {
    return await fn(pool)
  } catch (error: unknown) {
    throw mapPgError(error, { url: target.url, schema: target.schema, cli: target.cli })
  } finally {
    await pool.end().catch(() => undefined)
  }
}

async function hasSearchTables(pool: ReturnType<typeof createPool>): Promise<boolean> {
  const present = await pool.query<{ present: boolean }>(HAS_TABLES)
  return present.rows[0]?.present === true
}

/** Totals over the whole index, or `undefined` when search was never set up in this database. */
export async function readSearchTotals(target: SearchTarget): Promise<SearchTotals | undefined> {
  return withPool(target, async (pool) => {
    if (!(await hasSearchTables(pool))) return undefined
    const row = (await pool.query<{ indexed: string; chunks: string; skipped: string; last: string | null }>(TOTALS)).rows[0]
    return { indexed: Number(row?.indexed ?? 0), chunks: Number(row?.chunks ?? 0), skipped: Number(row?.skipped ?? 0), lastIndexedAt: row?.last ?? null }
  })
}

/** The deepest rule (on or off) containing the path, or `undefined`. */
function governingRule(absPath: string, rules: readonly IndexRule[], platform: NodeJS.Platform): IndexRule | undefined {
  const key = pathMatchKey(absPath, platform)
  let best: { rule: IndexRule; depth: number } | undefined
  for (const rule of rules) {
    const ruleKey = pathMatchKey(rule.path, platform)
    if (!isWithinOn(ruleKey, key, platform)) continue
    const depth = segmentCount(ruleKey)
    if (best === undefined || depth > best.depth) best = { rule, depth }
  }
  return best?.rule
}

type Tally = { indexed: number; chunks: number; skipped: number; pending: number }

function bump(tallies: Map<string, Tally>, rule: IndexRule | undefined, change: Partial<Tally>): void {
  if (rule === undefined || !rule.enabled) return
  const current = tallies.get(rule.path) ?? { indexed: 0, chunks: 0, skipped: 0, pending: 0 }
  tallies.set(rule.path, {
    indexed: current.indexed + (change.indexed ?? 0),
    chunks: current.chunks + (change.chunks ?? 0),
    skipped: current.skipped + (change.skipped ?? 0),
    pending: current.pending + (change.pending ?? 0),
  })
}

export interface RuleCountsInput {
  readonly roots: readonly string[]
  readonly rules: readonly IndexRule[]
  readonly platform: NodeJS.Platform
  /** The model the index is meant to hold: files embedded by another count as pending. */
  readonly model: string
}

/**
 * Per enabled rule: indexed files, their chunks, skipped files and files still
 * to do. A file counts toward the deepest rule that covers it. `undefined`
 * when search was never set up in this database.
 */
export async function readRuleCounts(target: SearchTarget, input: RuleCountsInput): Promise<ReadonlyMap<string, RuleCounts> | undefined> {
  return withPool(target, async (pool) => {
    if (!(await hasSearchTables(pool))) return undefined
    const [files, rows] = await Promise.all([loadCatalogFiles(pool, input.roots), loadIndexRows(pool)])
    const plan = planIndex({ files, rows, rules: input.rules, platform: input.platform, model: input.model })
    const tallies = new Map<string, Tally>()
    const doomed = new Set(plan.remove.map((row) => `${row.root}\u0000${row.relPath}`))
    for (const row of rows) {
      if (doomed.has(`${row.root}\u0000${row.relPath}`)) continue
      const rule = governingRule(absoluteOf(row.root, row.relPath, input.platform), input.rules, input.platform)
      bump(tallies, rule, row.status === 'indexed' ? { indexed: 1, chunks: row.chunks } : { skipped: 1 })
    }
    for (const work of plan.work) bump(tallies, governingRule(work.abs, input.rules, input.platform), { pending: 1 })
    for (const file of plan.waiting) bump(tallies, governingRule(absoluteOf(file.root, file.relPath, input.platform), input.rules, input.platform), { pending: 1 })
    return new Map(
      input.rules
        .filter((rule) => rule.enabled)
        .map((rule) => [rule.path, tallies.get(rule.path) ?? { indexed: 0, chunks: 0, skipped: 0, pending: 0 }]),
    )
  })
}
