import type { BigIntStats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { hasTrashSegment, isWithinOn, pathModuleOf } from '../names.js'
import { hashCatalogFile, type HashFile } from './catalog-hash.js'
import { deleteRows, deleteSubtree, loadKnownRow, loadKnownRows, upsertRows, type CatalogRow, type KnownRows } from './catalog-store.js'
import type { FilesDb } from './connection.js'
import { CATALOG_HASH_MAX_BYTES, CATALOG_MAX_ENTRIES } from './constants.js'

/**
 * The catalog of every declared root (ADR-0020 §6): files and folders, size,
 * mtime and a sha256 for files that are not huge. `lstat` only, symlinks are
 * never followed and never recorded, the trash is not part of the tree. A file
 * is hashed again only when its size or mtime moved. Rows are deleted only
 * when the whole root was seen — a truncated or partly unreadable walk keeps
 * what it did not reach.
 */

export interface WalkOptions {
  readonly roots: readonly string[]
  readonly now: Date
  readonly maxEntries?: number
  readonly hashMaxBytes?: number
  /** @internal test seam. */
  readonly hash?: HashFile
}

export interface RootWalk {
  readonly root: string
  readonly files: number
  readonly dirs: number
  readonly added: number
  readonly changed: number
  readonly removed: number
  readonly truncated: boolean
  /** Folders that could not be read: their rows are kept. */
  readonly unreadable: number
  /** The root itself could not be walked; its rows are untouched. */
  readonly error?: string
}

interface Seen {
  readonly rows: readonly CatalogRow[]
  readonly truncated: boolean
  readonly unreadable: number
}

function toRelPath(parts: readonly string[]): string {
  return parts.join('/')
}

async function rowOf(
  file: string,
  relPath: string,
  info: BigIntStats,
  known: CatalogRow | undefined,
  opts: { hashMaxBytes: number; hash: HashFile },
): Promise<CatalogRow> {
  const size = Number(info.size)
  const mtime = Math.floor(Number(info.mtimeMs))
  if (info.isDirectory()) return { rel_path: relPath, kind: 'dir', size: 0, mtime_ms: mtime, sha256: null }
  const isUnchanged = known?.kind === 'file' && known.size === size && known.mtime_ms === mtime
  if (isUnchanged) return known
  const sha256 = size > opts.hashMaxBytes ? null : await opts.hash(file, info)
  return { rel_path: relPath, kind: 'file', size, mtime_ms: mtime, sha256 }
}

async function readDirectory(dir: string): Promise<string[] | undefined> {
  try {
    return await readdir(dir)
  } catch {
    return undefined
  }
}

async function collect(root: string, known: KnownRows, opts: { maxEntries: number; hashMaxBytes: number; hash: HashFile }): Promise<Seen> {
  const rows: CatalogRow[] = []
  let unreadable = 0
  const pending: Array<{ dir: string; parts: readonly string[] }> = [{ dir: root, parts: [] }]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const names = await readDirectory(next.dir)
    if (names === undefined) {
      unreadable += 1
      continue
    }
    for (const name of names) {
      if (next.parts.length === 0 && hasTrashSegment(name)) continue
      if (rows.length >= opts.maxEntries) return { rows, truncated: true, unreadable }
      const file = path.join(next.dir, name)
      const info = await lstat(file, { bigint: true }).catch(() => undefined)
      if (info === undefined || (!info.isDirectory() && !info.isFile())) continue
      const parts = [...next.parts, name]
      const relPath = toRelPath(parts)
      rows.push(await rowOf(file, relPath, info, known.get(relPath), opts))
      if (info.isDirectory()) pending.push({ dir: file, parts })
    }
  }
  return { rows, truncated: false, unreadable }
}

function countChanges(rows: readonly CatalogRow[], known: KnownRows): { added: number; changed: number } {
  const added = rows.filter((row) => !known.has(row.rel_path)).length
  const changed = rows.filter((row) => {
    const before = known.get(row.rel_path)
    return before !== undefined && (before.kind !== row.kind || before.size !== row.size || before.mtime_ms !== row.mtime_ms || before.sha256 !== row.sha256)
  }).length
  return { added, changed }
}

async function walkRoot(db: FilesDb, root: string, opts: { now: Date; maxEntries: number; hashMaxBytes: number; hash: HashFile }): Promise<RootWalk> {
  const empty = { root, files: 0, dirs: 0, added: 0, changed: 0, removed: 0, truncated: false, unreadable: 0 }
  const isReadable = await readDirectory(root)
  if (isReadable === undefined) return { ...empty, error: 'the folder is gone or cannot be read' }
  const known = await loadKnownRows(db, root)
  const seen = await collect(root, known, opts)
  await upsertRows(db, root, opts.now, seen.rows)
  const { added, changed } = countChanges(seen.rows, known)
  const isComplete = !seen.truncated && seen.unreadable === 0
  const present = new Set(seen.rows.map((row) => row.rel_path))
  const gone = isComplete ? [...known.keys()].filter((relPath) => !present.has(relPath)) : []
  await deleteRows(db, root, gone)
  return {
    root,
    files: seen.rows.filter((row) => row.kind === 'file').length,
    dirs: seen.rows.filter((row) => row.kind === 'dir').length,
    added,
    changed,
    removed: gone.length,
    truncated: seen.truncated,
    unreadable: seen.unreadable,
  }
}

export async function walkRoots(db: FilesDb, opts: WalkOptions): Promise<readonly RootWalk[]> {
  const settings = {
    now: opts.now,
    maxEntries: opts.maxEntries ?? CATALOG_MAX_ENTRIES,
    hashMaxBytes: opts.hashMaxBytes ?? CATALOG_HASH_MAX_BYTES,
    hash: opts.hash ?? hashCatalogFile,
  }
  const results: RootWalk[] = []
  for (const root of opts.roots) results.push(await walkRoot(db, root, settings))
  return results
}

function rootOf(roots: readonly string[], target: string, platform: NodeJS.Platform): string | undefined {
  return roots.find((root) => isWithinOn(root, target, platform))
}

/** Re-stats just these paths after file writes: present → upsert, absent → delete (a folder with its subtree). */
export async function refreshCatalogPaths(
  db: FilesDb,
  opts: { roots: readonly string[]; paths: readonly string[]; now: Date; platform?: NodeJS.Platform; hashMaxBytes?: number; hash?: HashFile },
): Promise<void> {
  const platform = opts.platform ?? process.platform
  const pathModule = pathModuleOf(platform)
  const settings = { hashMaxBytes: opts.hashMaxBytes ?? CATALOG_HASH_MAX_BYTES, hash: opts.hash ?? hashCatalogFile }
  for (const target of new Set(opts.paths.filter((value) => pathModule.isAbsolute(value)))) {
    const root = rootOf(opts.roots, target, platform)
    if (root === undefined) continue
    const relPath = pathModule.relative(root, target).split(pathModule.sep).join('/')
    if (relPath === '' || hasTrashSegment(relPath)) continue
    await refreshOne(db, { root, relPath, target, now: opts.now, settings })
  }
}

async function refreshOne(
  db: FilesDb,
  one: { root: string; relPath: string; target: string; now: Date; settings: { hashMaxBytes: number; hash: HashFile } },
): Promise<void> {
  const info = await lstat(one.target, { bigint: true }).catch(() => undefined)
  if (info === undefined || (!info.isDirectory() && !info.isFile())) {
    await deleteSubtree(db, one.root, one.relPath)
    return
  }
  const known = await loadKnownRow(db, one.root, one.relPath)
  await upsertRows(db, one.root, one.now, [await rowOf(one.target, one.relPath, info, known, one.settings)])
}
