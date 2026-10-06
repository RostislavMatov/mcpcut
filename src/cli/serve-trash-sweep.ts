import { MS_PER_DAY, TRASH_RETENTION_DAYS } from '../files/constants.js'
import { purgeTrash } from '../files/io-trash-admin.js'
import { journalAccessEdit } from '../groups/journal-access-edit.js'
import { formatReadableField } from '../journal/format.js'

/**
 * The automatic purge of the file module's trash while `serve` runs
 * (ADR-0020 §4): once at startup, then every 24 hours, entries deleted more
 * than 30 days ago go for good, in every declared root. It is housekeeping,
 * not a request: a failure is one stderr line and never stops `serve`.
 */

export const TRASH_SWEEP_INTERVAL_MS = MS_PER_DAY

/** The two timer functions, injectable so a test can tick without waiting a day. */
export interface TrashSweepTimer {
  setInterval(handler: () => void, ms: number): { unref?: () => unknown }
  clearInterval(handle: { unref?: () => unknown }): void
}

const REAL_TIMER: TrashSweepTimer = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
}

export interface TrashSweepDeps {
  /** The declared root folders, read fresh on every run. */
  readonly listRoots: () => Promise<readonly string[]>
  readonly stderr: { write(chunk: string): unknown }
  readonly now: () => number
  readonly timer?: TrashSweepTimer
  /** Records a purge in the journal, so "who touched what" shows what went for good. */
  readonly journalPurge?: (root: string, deletedCount: number) => Promise<void>
}

export interface TrashSweep {
  /** The startup run; never rejects. */
  readonly done: Promise<void>
  /** The most recent run (startup or tick); never rejects. */
  idle(): Promise<void>
  /** Stops the schedule; a run already in flight finishes. */
  stop(): void
}

function describe(error: unknown): string {
  return formatReadableField(error instanceof Error ? error.message : String(error))
}

function report(deps: TrashSweepDeps, line: string): void {
  try {
    deps.stderr.write(`[serve] trash sweep: ${line}\n`)
  } catch {
    // A broken stderr must not take the housekeeping (or serve) down with it.
  }
}

async function sweepRoot(deps: TrashSweepDeps, root: string): Promise<void> {
  const purged = await purgeTrash(root, TRASH_RETENTION_DAYS * MS_PER_DAY, deps.now())
  const label = formatReadableField(root)
  if (!purged.ok) {
    report(deps, `${label}: ${formatReadableField(purged.message)}`)
    return
  }
  if (purged.value.purged > 0) await journalPurge(deps, root, purged.value.purged)
  if (purged.value.skipped.length > 0) {
    report(deps, `${label}: ${purged.value.skipped.length} entries could not be purged; list them with \`mcpcut files trash list ${label}\``)
  }
}

async function journalPurge(deps: TrashSweepDeps, root: string, count: number): Promise<void> {
  try {
    await deps.journalPurge?.(root, count)
  } catch (error: unknown) {
    report(deps, `${formatReadableField(root)}: purged ${count} item(s) but the journal record failed: ${describe(error)}`)
  }
}

async function sweepAll(deps: TrashSweepDeps): Promise<void> {
  try {
    const roots = await deps.listRoots()
    for (const root of roots) await sweepRoot(deps, root)
  } catch (error: unknown) {
    report(deps, describe(error))
  }
}

/** Starts the sweep: one run now, one every 24 hours until `stop()`. The timer never keeps the process alive. */
export function startTrashSweep(deps: TrashSweepDeps): TrashSweep {
  const timer = deps.timer ?? REAL_TIMER
  const done = sweepAll(deps)
  let latest = done
  const handle = timer.setInterval(() => {
    latest = sweepAll(deps)
  }, TRASH_SWEEP_INTERVAL_MS)
  handle.unref?.()
  return { done, idle: () => latest, stop: () => timer.clearInterval(handle) }
}

/** The journal side of a purge in `serve`: an access-edit with no admin behind it, `via: 'serve'`. */
export function journalPurgeTo(journalDir: string, stderr: { write(chunk: string): unknown }): (root: string, deletedCount: number) => Promise<void> {
  return async (root, deletedCount) => {
    const outcome = await journalAccessEdit({
      info: {
        actor: { adminName: null, role: null, via: 'serve' },
        action: 'files.trash.purge',
        path: root,
        olderThan: `${TRASH_RETENTION_DAYS}d`,
        deletedCount,
      },
      dir: journalDir,
      diagnostics: (line) => void stderr.write(line),
    })
    if (!outcome.written) throw new Error('the record was dropped')
  }
}
