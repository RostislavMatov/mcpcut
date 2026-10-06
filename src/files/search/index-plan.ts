import path from 'node:path'
import { pathMatchKey } from '../db/path-key.js'
import { pathModuleOf } from '../names.js'
import { FAILED_REASON, INDEX_MAX_FILE_BYTES, INDEX_RETRY_FAILED_MS } from './constants.js'
import type { IndexRule } from './index-rules-store.js'
import { prepareRuleLookup, skipReasonOfName } from './index-scope.js'

/**
 * What one indexing round has to do, decided from the catalog, the rows the
 * index already holds and the rules — pure, so every branch is a unit test.
 */

export interface CatalogFile {
  readonly root: string
  readonly relPath: string
  readonly size: number
  readonly sha256: string | null
}

export interface IndexRow {
  readonly root: string
  readonly relPath: string
  readonly status: 'indexed' | 'skipped'
  readonly reason: string | null
  readonly sha256: string | null
  readonly size: number
  readonly model: string
  readonly chunks: number
  /** When the row was written, in epoch milliseconds. */
  readonly indexedAt: number
}

export type SkipKind = 'secret-like name' | 'too large'

export type PlannedWork =
  | { readonly kind: 'skip'; readonly reason: SkipKind; readonly file: CatalogFile; readonly abs: string; readonly pathKey: string }
  /** `sha256` is the catalog hash the content must still match when it is read. */
  | { readonly kind: 'index'; readonly sha256: string; readonly file: CatalogFile; readonly abs: string; readonly pathKey: string }

export interface IndexPlan {
  /** Index rows to delete: out of scope, or no longer in the catalog. */
  readonly remove: ReadonlyArray<{ readonly root: string; readonly relPath: string }>
  /**
   * Per index rule: files with no row first, then changed ones by how long ago they were last indexed (oldest first),
   * ties by (root, rel_path). The rules take turns, so one folder's flood cannot keep another's files waiting.
   */
  readonly work: readonly PlannedWork[]
  /** In-scope files whose catalog hash is not computed yet: they wait for a later round. */
  readonly waiting: readonly CatalogFile[]
}

export interface PlanInput {
  readonly files: readonly CatalogFile[]
  readonly rows: readonly IndexRow[]
  readonly rules: readonly IndexRule[]
  readonly platform: NodeJS.Platform
  readonly model: string
  readonly now: Date
}

export function absoluteOf(root: string, relPath: string, platform: NodeJS.Platform): string {
  const paths: path.PlatformPath = pathModuleOf(platform)
  return paths.join(root, ...relPath.split('/'))
}

const keyOf = (root: string, relPath: string): string => `${root}\u0000${relPath}`

function isDone(row: IndexRow | undefined, expected: { sha256: string | null; model: string; reason?: SkipKind }): boolean {
  if (row === undefined || row.model !== expected.model) return false
  if (row.reason === FAILED_REASON) return false
  if (expected.reason !== undefined) {
    return row.status === 'skipped' && row.reason === expected.reason && row.sha256 === expected.sha256
  }
  return row.sha256 === expected.sha256
}

/** A file that failed with this very content and model is left alone until the retry delay has passed. */
function isParkedFailure(row: IndexRow | undefined, sha256: string | null, input: PlanInput): boolean {
  if (row === undefined || row.reason !== FAILED_REASON || row.model !== input.model || row.sha256 !== sha256) return false
  return input.now.getTime() - row.indexedAt < INDEX_RETRY_FAILED_MS
}

function workOf(file: CatalogFile, row: IndexRow | undefined, input: PlanInput): PlannedWork | 'waiting' | undefined {
  const abs = absoluteOf(file.root, file.relPath, input.platform)
  const pathKey = pathMatchKey(abs, input.platform)
  if (skipReasonOfName(file.relPath, file.root) === 'secret-like name') {
    const done = isDone(row, { sha256: file.sha256, model: input.model, reason: 'secret-like name' })
    return done ? undefined : { kind: 'skip', reason: 'secret-like name', file, abs, pathKey }
  }
  if (file.sha256 === null) {
    if (file.size <= INDEX_MAX_FILE_BYTES) return 'waiting'
    const done = isDone(row, { sha256: null, model: input.model, reason: 'too large' }) && row?.size === file.size
    return done ? undefined : { kind: 'skip', reason: 'too large', file, abs, pathKey }
  }
  if (isDone(row, { sha256: file.sha256, model: input.model })) return undefined
  if (isParkedFailure(row, file.sha256, input)) return undefined
  return { kind: 'index', sha256: file.sha256, file, abs, pathKey }
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/** Never indexed first, then the longest-waiting; a file rewritten every minute cannot take every round. */
function byTurn(rowsByKey: ReadonlyMap<string, IndexRow>): (left: PlannedWork, right: PlannedWork) => number {
  const stamp = (work: PlannedWork): number => rowsByKey.get(keyOf(work.file.root, work.file.relPath))?.indexedAt ?? Number.NEGATIVE_INFINITY
  return (left, right) => {
    const [a, b] = [stamp(left), stamp(right)]
    if (a !== b) return a < b ? -1 : 1
    return compareText(left.file.root, right.file.root) || compareText(left.file.relPath, right.file.relPath)
  }
}

/** One from each group in turn, the groups in the order their first file appears; each group keeps its own order. */
function interleave(work: readonly PlannedWork[], groupOf: (work: PlannedWork) => string): PlannedWork[] {
  const groups = new Map<string, PlannedWork[]>()
  for (const item of work) {
    const key = groupOf(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const queues = [...groups.values()]
  const turns = Math.max(0, ...queues.map((queue) => queue.length))
  return Array.from({ length: turns }, (_, turn) => queues.flatMap((queue) => queue[turn] ?? [])).flat()
}

export function planIndex(input: PlanInput): IndexPlan {
  const rowsByKey = new Map(input.rows.map((row) => [keyOf(row.root, row.relPath), row]))
  const ruleOf = prepareRuleLookup(input.rules, input.platform)
  const inScope = input.files.filter(
    (file) => skipReasonOfName(file.relPath, file.root) !== 'skipped folder' && ruleOf(absoluteOf(file.root, file.relPath, input.platform))?.enabled === true,
  )
  const keep = new Set(inScope.map((file) => keyOf(file.root, file.relPath)))
  const remove = input.rows.filter((row) => !keep.has(keyOf(row.root, row.relPath))).map((row) => ({ root: row.root, relPath: row.relPath }))
  const work: PlannedWork[] = []
  const waiting: CatalogFile[] = []
  for (const file of inScope) {
    const planned = workOf(file, rowsByKey.get(keyOf(file.root, file.relPath)), input)
    if (planned === 'waiting') waiting.push(file)
    else if (planned !== undefined) work.push(planned)
  }
  const sorted = [...work].sort(byTurn(rowsByKey))
  return { remove, work: interleave(sorted, (item) => ruleOf(item.abs)?.key ?? item.file.root), waiting }
}
