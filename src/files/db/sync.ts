import type { FilesDb } from './connection.js'
import { refreshCatalogPaths, walkRoots, type RootWalk } from './catalog-walk.js'
import { clearIndexIfPresent, indexOnce, type IndexResult } from '../search/indexer.js'
import type { IndexRule } from '../search/index-rules-store.js'
import { ensureSearchSchema } from '../search/search-schema.js'
import type { Embedder } from '../search/types.js'
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
  /** Search by meaning: after the catalog step, the index is brought current. Absent: the index is not touched. */
  readonly index?: SyncIndexOptions
}

export interface SyncIndexOptions {
  readonly rules: readonly IndexRule[]
  /** The model the index is planned against (`SEARCH_MODEL_ID`); planning never loads it. */
  readonly modelId: string
  /** Called only when a file has to be embedded; the embedder is closed when the round ends. */
  readonly embedder: () => Promise<Embedder>
  readonly budgetMs: number
  readonly cli?: string
  readonly onProgress?: (done: number, total: number) => void
}

/** What the index step did: a result, or the one line saying why it could not run (never thrown). */
export interface SyncIndexOutcome {
  readonly result?: IndexResult
  readonly problem?: string
}

export interface SyncResult {
  readonly ingest: IngestResult
  /** Empty when the walk was not asked for. */
  readonly walks: readonly RootWalk[]
  /** Present when `index` was asked for (and there was something to do or to report). */
  readonly index?: SyncIndexOutcome
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
  const index = opts.index === undefined ? undefined : await indexStep(db, opts, opts.index)
  return { ingest, walks, ...(index === undefined ? {} : { index }) }
}

async function indexStep(db: FilesDb, opts: SyncOptions, index: SyncIndexOptions): Promise<SyncIndexOutcome | undefined> {
  try {
    if (!index.rules.some((rule) => rule.enabled)) {
      const cleared = await clearIndexIfPresent(db)
      return cleared === undefined ? undefined : { result: cleared }
    }
    const sdb = await ensureSearchSchema(db, index.cli === undefined ? {} : { cli: index.cli })
    const result = await indexOnce(sdb, {
      roots: opts.roots,
      rules: index.rules,
      modelId: index.modelId,
      createEmbedder: index.embedder,
      now: opts.now,
      budgetMs: index.budgetMs,
      platform: opts.platform,
      ...(index.onProgress === undefined ? {} : { onProgress: index.onProgress }),
    })
    return { result }
  } catch (error: unknown) {
    return { problem: error instanceof Error ? error.message : String(error) }
  }
}
