import type { FilesDb } from './connection.js'
import { refreshCatalogPaths, walkRoots, type RootWalk } from './catalog-walk.js'
import { ingestJournal, type IngestResult } from './ingest.js'

/**
 * One round of keeping Postgres current: ingest the journal, re-stat the paths
 * its new write events touched, and — when asked — walk every declared root.
 * Shared by `files db sync` and the sync inside `serve`.
 */

export interface SyncOptions {
  readonly journalDir: string
  readonly roots: readonly string[]
  readonly platform: NodeJS.Platform
  readonly now: Date
  readonly withWalk: boolean
  /** Ingest time budget; unbounded when absent. */
  readonly budgetMs?: number
}

export interface SyncResult {
  readonly ingest: IngestResult
  /** Empty when the walk was not asked for. */
  readonly walks: readonly RootWalk[]
}

export async function syncOnce(db: FilesDb, opts: SyncOptions): Promise<SyncResult> {
  const ingest = await ingestJournal(db, {
    journalDir: opts.journalDir,
    platform: opts.platform,
    budgetMs: opts.budgetMs ?? Number.POSITIVE_INFINITY,
  })
  if (ingest.touched.length > 0) {
    await refreshCatalogPaths(db, { roots: opts.roots, paths: ingest.touched, now: opts.now, platform: opts.platform })
  }
  const walks = opts.withWalk ? await walkRoots(db, { roots: opts.roots, now: opts.now }) : []
  return { ingest, walks }
}
