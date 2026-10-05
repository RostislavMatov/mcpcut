import { openConfiguredDb, type OpenConfiguredOptions } from '../files/db/open-configured.js'
import type { FilesDb } from '../files/db/connection.js'
import { walkRoots } from '../files/db/catalog-walk.js'
import { syncOnce } from '../files/db/sync.js'
import { modulesDirOf } from '../files/db/pg-loader.js'
import { INDEX_SERVE_BUDGET_MS } from '../files/search/constants.js'
import { createLocalEmbedder } from '../files/search/embedder.js'
import { createIndexRulesStore, type IndexRule } from '../files/search/index-rules-store.js'
import type { Embedder } from '../files/search/types.js'
import { formatReadableField } from '../journal/format.js'
import type { TrashSweepTimer } from './serve-trash-sweep.js'

/**
 * Keeps the Postgres index current while `serve` runs (ADR-0020 §6): the
 * journal is ingested and the touched catalog paths refreshed every minute,
 * every declared root is walked once at start and then every hour. Mode off
 * does nothing and says nothing. Like the trash sweep it is housekeeping, not
 * a request: a failure is one stderr line per distinct reason and never stops
 * `serve`. One database handle lives as long as `serve`; a failed open is
 * retried on the next tick. The ingest and the walk are two guarded steps, so
 * the minute ingest keeps running during a long walk (the pool has two clients).
 */

export const FILES_SYNC_INTERVAL_MS = 60_000
export const FILES_WALK_INTERVAL_MS = 60 * 60_000

export type FilesSyncTimer = TrashSweepTimer

export interface FilesSyncDeps extends Omit<OpenConfiguredOptions, 'journalDir'> {
  readonly journalDir: string
  /** The declared root folders, read fresh on every run. */
  readonly listRoots: () => Promise<readonly string[]>
  readonly stderr: { write(chunk: string): unknown }
  readonly now: () => number
  readonly platform?: NodeJS.Platform
  readonly timer?: FilesSyncTimer
  /** @internal test seam: the catalog walk. */
  readonly walk?: typeof walkRoots
  /** The index rules, read fresh on every run; the store in `journalDir` by default. */
  readonly listIndexRules?: () => Promise<readonly IndexRule[]>
  /** @internal test seam: the embedder, created lazily on the first round that has a rule on. */
  readonly createEmbedder?: (modulesDir: string) => Promise<Embedder>
}

export interface FilesSync {
  /** The startup run (ingest and walk); never rejects. */
  readonly done: Promise<void>
  /** Resolves when no run is in flight, however many started meanwhile; never rejects. */
  idle(): Promise<void>
  /** Stops the schedule, lets the runs in flight finish, then closes the database. */
  stop(): Promise<void>
}

const REAL_TIMER: FilesSyncTimer = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
}

function describe(error: unknown): string {
  return formatReadableField(error instanceof Error ? error.message : String(error))
}

export function startFilesSync(deps: FilesSyncDeps): FilesSync {
  const timer = deps.timer ?? REAL_TIMER
  const walk = deps.walk ?? walkRoots
  const platform = deps.platform ?? process.platform
  let db: FilesDb | undefined
  let opening: Promise<FilesDb | undefined> | undefined
  let embedder: Embedder | undefined
  let lastWalkAt: number | undefined
  let isStopped = false
  /** The last line printed per source (`open`, `ingest`, `walk`): a repeat is not printed again. */
  const lastReported = new Map<string, string>()
  const busy = new Set<string>()
  const inFlight = new Set<Promise<void>>()

  const report = (source: string, line: string): void => {
    if (line === lastReported.get(source)) return
    lastReported.set(source, line)
    try {
      deps.stderr.write(`[serve] files sync: ${line}\n`)
    } catch {
      // A broken stderr must not take the housekeeping (or serve) down with it.
    }
  }

  async function open(): Promise<FilesDb | undefined> {
    const configured = await openConfiguredDb(deps)
    if (configured.kind === 'unavailable') report('open', configured.reason)
    if (configured.kind !== 'ready') return undefined
    lastReported.delete('open')
    if (isStopped) {
      // A late open: `stop` has already passed, nobody will close this handle but us.
      await configured.db.close().catch(() => undefined)
      return undefined
    }
    db = configured.db
    return db
  }

  /** One open at a time; a failed one is forgotten so the next tick tries again. */
  async function ensureDb(): Promise<FilesDb | undefined> {
    if (db !== undefined) return db
    opening ??= open().finally(() => {
      opening = undefined
    })
    return opening
  }

  /** One embedder for the life of `serve`, made on the first round that needs it; a failed creation is retried next round. */
  async function ensureEmbedder(): Promise<Embedder> {
    if (embedder !== undefined) return embedder
    const created = await (deps.createEmbedder ?? ((modulesDir) => createLocalEmbedder({ modulesDir })))(modulesDirOf(deps.journalDir))
    if (isStopped) {
      await created.close().catch(() => undefined)
      throw new Error('serve is stopping')
    }
    embedder = created
    return created
  }

  async function indexRules(): Promise<readonly IndexRule[]> {
    try {
      return await (deps.listIndexRules ?? (() => createIndexRulesStore({ journalDir: deps.journalDir }).list()))()
    } catch (error: unknown) {
      report('index', `could not read the index rules: ${describe(error)}`)
      return []
    }
  }

  async function ingestStep(): Promise<void> {
    const handle = await ensureDb()
    if (handle === undefined) return
    const synced = await syncOnce(handle, {
      journalDir: deps.journalDir,
      roots: await deps.listRoots(),
      platform,
      now: new Date(deps.now()),
      withWalk: false,
      index: { rules: await indexRules(), embedder: ensureEmbedder, budgetMs: INDEX_SERVE_BUDGET_MS, cli: deps.cli },
    })
    reportIndex(synced.index)
  }

  /** A problem is printed once per change (the next successful round forgets it); a failed file is named once. */
  function reportIndex(outcome: Awaited<ReturnType<typeof syncOnce>>['index']): void {
    if (outcome?.problem !== undefined) return report('index', `search index: ${formatReadableField(outcome.problem)}`)
    const failure = outcome?.result?.firstFailure
    if (failure !== undefined) return report('index', `search index: ${formatReadableField(failure)} (will retry)`)
    lastReported.delete('index')
  }

  async function walkStep(): Promise<void> {
    const at = deps.now()
    const isDue = lastWalkAt === undefined || at - lastWalkAt >= FILES_WALK_INTERVAL_MS
    if (!isDue) return
    const handle = await ensureDb()
    if (handle === undefined) return
    await walk(handle, { roots: await deps.listRoots(), now: new Date(at) })
    lastWalkAt = at
  }

  /** Runs a step unless it is already running or `serve` is stopping; a failure is reported, never thrown. */
  function launch(name: string, step: () => Promise<void>): Promise<void> {
    if (isStopped || busy.has(name)) return Promise.resolve()
    busy.add(name)
    const run: Promise<void> = step()
      .then(() => void lastReported.delete(name))
      .catch((error: unknown) => report(name, describe(error)))
      .finally(() => {
        busy.delete(name)
        inFlight.delete(run)
      })
    inFlight.add(run)
    return run
  }

  const runAll = (): Promise<void> => Promise.all([launch('ingest', ingestStep), launch('walk', walkStep)]).then(() => undefined)

  const idle = async (): Promise<void> => {
    while (inFlight.size > 0) await Promise.all([...inFlight])
  }

  const done = runAll()
  const handle = timer.setInterval(() => void runAll(), FILES_SYNC_INTERVAL_MS)
  handle.unref?.()
  return {
    done,
    idle,
    stop: async () => {
      isStopped = true
      timer.clearInterval(handle)
      await idle()
      await opening
      await embedder?.close().catch(() => undefined)
      embedder = undefined
      await db?.close().catch(() => undefined)
      db = undefined
    },
  }
}
