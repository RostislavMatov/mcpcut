import { openConfiguredDb, type OpenConfiguredOptions } from '../files/db/open-configured.js'
import type { FilesDb } from '../files/db/connection.js'
import { syncOnce } from '../files/db/sync.js'
import { formatReadableField } from '../journal/format.js'
import type { TrashSweepTimer } from './serve-trash-sweep.js'

/**
 * Keeps the Postgres index current while `serve` runs (ADR-0020 §6): the
 * journal is ingested and the touched catalog paths refreshed every minute,
 * every declared root is walked once at start and then every hour. Mode off
 * does nothing and says nothing. Like the trash sweep it is housekeeping, not
 * a request: a failure is one stderr line per distinct reason and never stops
 * `serve`. One database handle lives as long as `serve`; a failed open is
 * retried on the next tick.
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
}

export interface FilesSync {
  /** The startup run; never rejects. */
  readonly done: Promise<void>
  /** The most recent run (startup or tick); never rejects. */
  idle(): Promise<void>
  /** Stops the schedule, lets a run in flight finish, then closes the database. */
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
  let db: FilesDb | undefined
  let lastWalkAt: number | undefined
  let lastReported: string | undefined
  let isRunning = false

  const report = (line: string): void => {
    if (line === lastReported) return
    lastReported = line
    try {
      deps.stderr.write(`[serve] files sync: ${line}\n`)
    } catch {
      // A broken stderr must not take the housekeeping (or serve) down with it.
    }
  }

  async function ensureDb(): Promise<FilesDb | undefined> {
    if (db !== undefined) return db
    const configured = await openConfiguredDb(deps)
    if (configured.kind === 'unavailable') report(configured.reason)
    if (configured.kind === 'ready') db = configured.db
    return db
  }

  async function runOnce(): Promise<void> {
    if (isRunning) return
    isRunning = true
    try {
      const open = await ensureDb()
      if (open === undefined) return
      const at = deps.now()
      const isWalkDue = lastWalkAt === undefined || at - lastWalkAt >= FILES_WALK_INTERVAL_MS
      await syncOnce(open, {
        journalDir: deps.journalDir,
        roots: await deps.listRoots(),
        platform: deps.platform ?? process.platform,
        now: new Date(at),
        withWalk: isWalkDue,
      })
      if (isWalkDue) lastWalkAt = at
      lastReported = undefined
    } catch (error: unknown) {
      report(describe(error))
    } finally {
      isRunning = false
    }
  }

  const done = runOnce()
  let latest = done
  const handle = timer.setInterval(() => {
    latest = runOnce()
  }, FILES_SYNC_INTERVAL_MS)
  handle.unref?.()
  return {
    done,
    idle: () => latest,
    stop: async () => {
      timer.clearInterval(handle)
      await latest
      await db?.close().catch(() => undefined)
      db = undefined
    },
  }
}
