import {
  ACCESS_EDIT_SESSION_ID,
  buildAccessEditRecord,
  type AccessEditInfo,
} from '../journal/access-edit-record.js'
import { createJournalSink, type JournalSinkOptions } from '../journal/sink.js'

/**
 * Writes ONE `kind: 'access-edit'` record into `journal.db` (plan
 * m55-server-groups Task 8) through the existing sink — same batch writer,
 * same chain link, same signed head — under the reserved
 * `ACCESS_EDIT_SESSION_ID`. The exact sibling of
 * `policy/edit/journal-edit.ts`: the access change already happened in the
 * store when this runs, so a journal that cannot be reached must never turn a
 * completed change into a failed command. This function NEVER throws; the
 * caller gets a drop indicator instead, said out loud on the diagnostics sink.
 */

export interface JournalAccessEditInput {
  readonly info: AccessEditInfo
  /** Journal directory holding `journal.db`. Defaults to the sink's JOURNAL_DIR. */
  readonly dir?: string
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  readonly clock?: () => number
  /** Diagnostics sink for a dropped record. Defaults to `process.stderr`. */
  readonly diagnostics?: (line: string) => void
  /** @internal test-only sink seams (retry delay, fault-injected commit). */
  readonly sinkOptions?: Pick<JournalSinkOptions, 'retryDelayMs' | 'commitBatchImpl'>
}

/** How the write ended: `written` is false exactly when the record was dropped. */
export interface JournalAccessEditOutcome {
  readonly written: boolean
  readonly droppedCount: number
}

const DROP_DIAGNOSTIC_PREFIX = '[journal] failed to write an access-edit record'

export async function journalAccessEdit(
  input: JournalAccessEditInput,
): Promise<JournalAccessEditOutcome> {
  const diagnostics = input.diagnostics ?? ((line: string) => process.stderr.write(line))
  try {
    const record = buildAccessEditRecord({
      info: input.info,
      ...(input.clock !== undefined ? { clock: input.clock } : {}),
    })
    const sink = createJournalSink(ACCESS_EDIT_SESSION_ID, {
      ...(input.dir !== undefined ? { dir: input.dir } : {}),
      ...(input.sinkOptions ?? {}),
    })
    sink.write(record)
    await sink.close()
    const droppedCount = sink.droppedRecordCount()
    if (droppedCount > 0) diagnostics(`${DROP_DIAGNOSTIC_PREFIX}: dropped after retry\n`)
    return { written: droppedCount === 0, droppedCount }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    diagnostics(`${DROP_DIAGNOSTIC_PREFIX}: ${message}\n`)
    return { written: false, droppedCount: 1 }
  }
}
