import {
  buildPolicyEditRecord,
  POLICY_EDIT_SESSION_ID,
  type PolicyEditInfo,
} from '../../journal/policy-edit-record.js'
import { createJournalSink, type JournalSinkOptions } from '../../journal/sink.js'

/**
 * Writes ONE `kind: 'policy-edit'` record into `journal.db` (owner decision
 * O5) through the existing sink — same batch writer, same chain link, same
 * signed head — under the reserved `POLICY_EDIT_SESSION_ID`. The exact
 * sibling of `probe/journal-probe.ts`: the edit already happened on disk
 * when this runs, so a journal that cannot be reached must never turn a
 * written policy into a failed request. This function NEVER throws; the
 * caller gets a drop indicator instead, said out loud on the diagnostics sink.
 */

export interface JournalPolicyEditInput {
  readonly edit: PolicyEditInfo
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
export interface JournalPolicyEditOutcome {
  readonly written: boolean
  readonly droppedCount: number
}

const DROP_DIAGNOSTIC_PREFIX = '[journal] failed to write a policy-edit record'

export async function journalPolicyEdit(input: JournalPolicyEditInput): Promise<JournalPolicyEditOutcome> {
  const diagnostics = input.diagnostics ?? ((line: string) => process.stderr.write(line))
  try {
    const record = buildPolicyEditRecord({
      edit: input.edit,
      ...(input.clock !== undefined ? { clock: input.clock } : {}),
    })
    const sink = createJournalSink(POLICY_EDIT_SESSION_ID, {
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
