import path from 'node:path'
import { pathMatchKey } from '../db/path-key.js'
import { pathModuleOf } from '../names.js'
import { INDEX_MAX_FILE_BYTES } from './constants.js'
import type { IndexRule } from './index-rules-store.js'
import { prepareIndexRules, skipReasonOfName } from './index-scope.js'

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
}

export type SkipKind = 'secret-like name' | 'too large'

export type PlannedWork =
  | { readonly kind: 'skip'; readonly reason: SkipKind; readonly file: CatalogFile; readonly abs: string; readonly pathKey: string }
  /** `sha256` is the catalog hash the content must still match when it is read. */
  | { readonly kind: 'index'; readonly sha256: string; readonly file: CatalogFile; readonly abs: string; readonly pathKey: string }

export interface IndexPlan {
  /** Index rows to delete: out of scope, or no longer in the catalog. */
  readonly remove: ReadonlyArray<{ readonly root: string; readonly relPath: string }>
  /** In deterministic (root, rel_path) order. */
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
}

export function absoluteOf(root: string, relPath: string, platform: NodeJS.Platform): string {
  const paths: path.PlatformPath = pathModuleOf(platform)
  return paths.join(root, ...relPath.split('/'))
}

const keyOf = (root: string, relPath: string): string => `${root}\u0000${relPath}`

function isDone(row: IndexRow | undefined, expected: { sha256: string | null; model: string; reason?: SkipKind }): boolean {
  if (row === undefined || row.model !== expected.model) return false
  if (expected.reason !== undefined) {
    return row.status === 'skipped' && row.reason === expected.reason && row.sha256 === expected.sha256
  }
  return row.sha256 === expected.sha256
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
  return { kind: 'index', sha256: file.sha256, file, abs, pathKey }
}

export function planIndex(input: PlanInput): IndexPlan {
  const rowsByKey = new Map(input.rows.map((row) => [keyOf(row.root, row.relPath), row]))
  const isCovered = prepareIndexRules(input.rules, input.platform)
  const inScope = input.files.filter(
    (file) => skipReasonOfName(file.relPath, file.root) !== 'skipped folder' && isCovered(absoluteOf(file.root, file.relPath, input.platform)),
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
  return { remove, work, waiting }
}
