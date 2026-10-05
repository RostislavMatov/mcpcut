import { redactString } from '../../redact/redact.js'
import type { FilesDb } from '../db/connection.js'
import { FilesDbError } from '../db/errors.js'
import type { PgQueryable } from '../db/pg-types.js'
import { pathMatchKey } from '../db/path-key.js'
import { chunkText } from './chunk.js'
import { FAILED_REASON, INDEX_LOCK_KEY } from './constants.js'
import { planIndex, type PlannedWork } from './index-plan.js'
import type { IndexRule } from './index-rules-store.js'
import {
  deleteAllIndexRows,
  deleteIndexRows,
  loadCatalogFiles,
  loadIndexRows,
  writeIndexed,
  writeSkipped,
  type EmbeddedChunk,
  type FileWrite,
} from './index-store.js'
import { readIndexable } from './read-indexable.js'
import type { SearchDb } from './search-schema.js'
import type { Embedder } from './types.js'

/**
 * One round of keeping the search index current (ADR-0020 §6). The catalog
 * says which files exist and what their content hash is; the rules say which
 * are in scope; this embeds what changed. Secrets are kept out twice: files
 * with secret-like names are never opened, and the text of every other file
 * passes the journal's redaction before it is chunked, embedded or stored.
 */

export interface IndexOptions {
  readonly roots: readonly string[]
  readonly rules: readonly IndexRule[]
  /** The model the rows are stamped with and planned against; the model itself is not loaded to plan. */
  readonly modelId: string
  /** Called at most once per round, only when a file has to be embedded; the embedder is closed when the round ends. */
  readonly createEmbedder: () => Promise<Embedder>
  readonly now: Date
  /** Time the embedding may take; the rest is counted as pending. `Infinity` for no limit. */
  readonly budgetMs: number
  readonly platform: NodeJS.Platform
  /** Called after each file of the round with how many are done of how many planned. */
  readonly onProgress?: (done: number, total: number) => void
  /** @internal test seams. */
  readonly read?: typeof readIndexable
  readonly monotonicMs?: () => number
}

export interface IndexResult {
  /** Another process holds the indexing lock: nothing was done. */
  readonly busy?: true
  readonly indexed: number
  readonly skipped: number
  /** Why files were skipped this round, with counts. */
  readonly skippedByReason: Readonly<Record<string, number>>
  readonly removed: number
  /** Planned files not reached (budget, changed meanwhile) plus files whose catalog hash is not computed yet. */
  readonly pending: number
  /** Files whose embedding or write failed this round: parked (a `failed` row) until their content changes or an hour passes. */
  readonly failed: number
  /** The first failure, for the caller's log. */
  readonly firstFailure?: string
}

const EMPTY: IndexResult = { indexed: 0, skipped: 0, skippedByReason: {}, removed: 0, pending: 0, failed: 0 }

interface Tally {
  indexed: number
  skipped: number
  skippedByReason: Record<string, number>
  pending: number
  failed: number
  firstFailure: string | undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function embedChunks(text: string, relPath: string, embedder: Embedder): Promise<EmbeddedChunk[]> {
  const label = redactString(relPath)
  const chunks = chunkText(redactString(text))
  const embedded: EmbeddedChunk[] = []
  for (const chunk of chunks) {
    embedded.push({ ...chunk, embedding: await embedder.embedPassage(`${label}\n${chunk.body}`) })
  }
  return embedded
}

function writeOf(work: PlannedWork, opts: IndexOptions, sha256: string | null): FileWrite {
  return {
    root: work.file.root,
    relPath: work.file.relPath,
    pathKey: pathMatchKey(work.abs, opts.platform),
    sha256,
    size: work.file.size,
    model: opts.modelId,
    indexedAt: opts.now,
  }
}

function noteSkip(tally: Tally, reason: string): void {
  tally.skipped += 1
  tally.skippedByReason[reason] = (tally.skippedByReason[reason] ?? 0) + 1
}

/** The round's embedder: made on first use, closed by `close` whether or not the round succeeded. */
interface RoundEmbedder {
  get(): Promise<Embedder>
  /** The embedder could not be made (no runtime, no model): every file would fail the same way. */
  isUnavailable(): boolean
  close(): Promise<void>
}

function lazyEmbedder(create: () => Promise<Embedder>): RoundEmbedder {
  let made: Promise<Embedder> | undefined
  let isUnavailable = false
  return {
    get: () => (made ??= create().catch((error: unknown) => {
      isUnavailable = true
      throw error
    })),
    isUnavailable: () => isUnavailable,
    close: async () => {
      if (made === undefined) return
      const embedder = await made.catch(() => undefined)
      await embedder?.close().catch(() => undefined)
    },
  }
}

async function processOne(sdb: SearchDb, work: PlannedWork, opts: IndexOptions, embedder: RoundEmbedder, tally: Tally): Promise<void> {
  const write = writeOf(work, opts, work.file.sha256)
  if (work.kind === 'skip') {
    await sdb.db.transaction((tx) => writeSkipped(tx, write, work.reason))
    noteSkip(tally, work.reason)
    return
  }
  const read = await (opts.read ?? readIndexable)(work.abs, work.sha256)
  if (read.kind === 'changed') {
    tally.pending += 1
    return
  }
  if (read.kind === 'skip') {
    await sdb.db.transaction((tx) => writeSkipped(tx, write, read.reason))
    noteSkip(tally, read.reason)
    return
  }
  const chunks = await embedChunks(read.text, work.file.relPath, await embedder.get())
  await sdb.db.transaction((tx) => writeIndexed(tx, sdb.vectorSchema, write, chunks))
  tally.indexed += 1
}

/**
 * The failed file gets a row of its own (`skipped`, reason `failed`, its hash and model): the next
 * rounds leave it alone until its content changes or the retry delay passes. Best effort: when even
 * this write fails the file is simply tried again next round.
 */
async function parkFailure(sdb: SearchDb, work: PlannedWork, opts: IndexOptions): Promise<void> {
  try {
    await sdb.db.transaction((tx) => writeSkipped(tx, writeOf(work, opts, work.file.sha256), FAILED_REASON))
  } catch {
    // Nothing more to do: the failure is already counted and reported.
  }
}

async function processAll(sdb: SearchDb, work: readonly PlannedWork[], opts: IndexOptions, embedder: RoundEmbedder, tally: Tally): Promise<void> {
  const clock = opts.monotonicMs ?? (() => performance.now())
  const startedAt = clock()
  for (const [index, item] of work.entries()) {
    if (clock() - startedAt >= opts.budgetMs) {
      tally.pending += work.length - index
      return
    }
    try {
      await processOne(sdb, item, opts, embedder, tally)
    } catch (error: unknown) {
      // A dead server or a missing model fails every file the same way: stop instead of grinding through them.
      if (embedder.isUnavailable() || (error instanceof FilesDbError && error.kind === 'unreachable')) throw error
      tally.failed += 1
      tally.firstFailure ??= `${item.file.relPath}: ${describe(error)}`
      await parkFailure(sdb, item, opts)
    }
    opts.onProgress?.(index + 1, work.length)
  }
}

async function runRound(sdb: SearchDb, opts: IndexOptions): Promise<IndexResult> {
  if (!opts.rules.some((rule) => rule.enabled)) return { ...EMPTY, removed: await deleteAllIndexRows(sdb.db) }
  // One after the other: the lock holds one pooled client and the pool has two.
  const files = await loadCatalogFiles(sdb.db, opts.roots)
  const rows = await loadIndexRows(sdb.db)
  const plan = planIndex({ files, rows, rules: opts.rules, platform: opts.platform, model: opts.modelId, now: opts.now })
  const removed = await deleteIndexRows(sdb.db, plan.remove)
  const tally: Tally = { indexed: 0, skipped: 0, skippedByReason: {}, pending: plan.waiting.length, failed: 0, firstFailure: undefined }
  const embedder = lazyEmbedder(opts.createEmbedder)
  try {
    await processAll(sdb, plan.work, opts, embedder, tally)
  } finally {
    await embedder.close()
  }
  return {
    indexed: tally.indexed,
    skipped: tally.skipped,
    skippedByReason: tally.skippedByReason,
    removed,
    pending: tally.pending,
    failed: tally.failed,
    ...(tally.firstFailure === undefined ? {} : { firstFailure: tally.firstFailure }),
  }
}

/**
 * The lock key is `INDEX_LOCK_KEY` mixed with the schema name: one index per
 * mcpcut schema, so two schemas in one database (and parallel test schemas)
 * never block each other.
 */
const LOCK_KEY_SQL = '($1::bigint # hashtextextended(current_schema(), 0))'

async function tryLock(client: PgQueryable): Promise<boolean> {
  const locked = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(${LOCK_KEY_SQL}) AS locked`, [INDEX_LOCK_KEY])
  return locked.rows[0]?.locked === true
}

/** Runs `fn` holding the indexing lock on a dedicated connection; `undefined` when another process holds it. */
async function underIndexLock<T>(db: FilesDb, fn: () => Promise<T>): Promise<T | undefined> {
  return db.withClient(async (client) => {
    if (!(await tryLock(client))) return undefined
    let result: T
    try {
      result = await fn()
    } catch (error: unknown) {
      await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL})`, [INDEX_LOCK_KEY]).catch(() => undefined)
      throw error
    }
    // A failed unlock rejects: the client is destroyed, which ends the session and frees the lock.
    await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL})`, [INDEX_LOCK_KEY])
    return result
  })
}

/**
 * Brings the index to what the catalog and the rules say, within the time
 * budget. Only one process indexes at a time (an advisory lock held on a
 * dedicated connection); the other gets `{ busy: true }` and does nothing.
 */
export async function indexOnce(sdb: SearchDb, opts: IndexOptions): Promise<IndexResult> {
  return (await underIndexLock(sdb.db, () => runRound(sdb, opts))) ?? { ...EMPTY, busy: true as const }
}

/**
 * No rule is on: whatever an earlier round indexed goes. A database that never
 * had search tables has nothing to clear and is not touched (`undefined`).
 */
export async function clearIndexIfPresent(db: FilesDb): Promise<IndexResult | undefined> {
  const present = await db.query<{ present: boolean }>("SELECT to_regclass('search_files') IS NOT NULL AS present")
  if (present.rows[0]?.present !== true) return undefined
  const removed = await underIndexLock(db, () => deleteAllIndexRows(db))
  return removed === undefined ? { ...EMPTY, busy: true as const } : { ...EMPTY, removed }
}
