import type { BigIntStats } from 'node:fs'
import type { HashFile } from './catalog-hash.js'
import type { CatalogRow } from './catalog-store.js'
import { CATALOG_MAX_PATH_CODE_POINTS } from './constants.js'

/** One catalog row from one `lstat`: whether to hash, and how much hashing a walk may still do. */

/** Bytes a walk may still read for hashing, shared by its roots. The one deliberately mutable cell of a walk. */
export interface HashBudget {
  left: number
  /** Changed files recorded without a hash because the budget was spent. */
  deferred: number
}

export interface RowSettings {
  readonly hashMaxBytes: number
  readonly hash: HashFile
  readonly budget: HashBudget
}

export function isTooLong(value: string): boolean {
  return Array.from(value).length > CATALOG_MAX_PATH_CODE_POINTS
}

/** A file with a hash (or too big for one) whose size and mtime did not move is what the catalog already knows. */
function isKnownCurrent(known: CatalogRow | undefined, size: number, mtime: number, hashMaxBytes: number): known is CatalogRow {
  if (known?.kind !== 'file' || known.size !== size || known.mtime_ms !== mtime) return false
  return known.sha256 !== null || size > hashMaxBytes
}

async function hashWithin(file: string, info: BigIntStats, size: number, opts: RowSettings): Promise<string | null> {
  if (size > opts.hashMaxBytes) return null
  if (size > opts.budget.left) {
    opts.budget.deferred += 1
    return null
  }
  opts.budget.left -= size
  return opts.hash(file, info)
}

export async function rowOf(file: string, relPath: string, info: BigIntStats, known: CatalogRow | undefined, opts: RowSettings): Promise<CatalogRow> {
  const size = Number(info.size)
  const mtime = Math.floor(Number(info.mtimeMs))
  if (info.isDirectory()) return { rel_path: relPath, kind: 'dir', size: 0, mtime_ms: mtime, sha256: null }
  if (isKnownCurrent(known, size, mtime, opts.hashMaxBytes)) return known
  return { rel_path: relPath, kind: 'file', size, mtime_ms: mtime, sha256: await hashWithin(file, info, size, opts) }
}
