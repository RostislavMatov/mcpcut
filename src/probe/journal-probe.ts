import { buildProbeRecord, type ProbeRecordInfo } from '../journal/probe-record.js'
import { createJournalSink, type JournalSinkOptions } from '../journal/sink.js'
import { PROBE_SESSION_ID } from './constants.js'
import type { ProbeResult } from './engine.js'
import type { ProbeInitiator } from './status-schema.js'

/**
 * Writes the fact and outcome of ONE probe into `journal.db` (M5.5 п.1,
 * Task 5; ADR-0008 §6) through the EXISTING sink — same batch writer, same
 * chain link, same signed head — under the reserved `PROBE_SESSION_ID`.
 *
 * The journal write is evidence, not the source of operator truth (that is
 * the status store), so a record dropped by a busy database must never fail
 * the probe that produced it: this function NEVER throws — the caller gets
 * a drop indicator and count instead, mirroring the sink's own
 * `droppedRecordCount()` accounting.
 */

export interface JournalProbeInput {
  readonly serverName: string
  readonly initiator: ProbeInitiator
  readonly result: ProbeResult
  /** Journal directory holding `journal.db`. Defaults to the sink's JOURNAL_DIR. */
  readonly dir?: string
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  readonly clock?: () => number
  /** Exact secret values the probe's upstream was given (vault-resolved material). */
  readonly knownSecrets?: readonly string[]
  /** @internal test-only sink seams (retry delay, fault-injected commit). */
  readonly sinkOptions?: Pick<JournalSinkOptions, 'retryDelayMs' | 'commitBatchImpl'>
}

/** How the write ended: `written` is false exactly when the record was dropped. */
export interface JournalProbeOutcome {
  readonly written: boolean
  /** Records this call dropped (0 or 1 — one call writes one record). */
  readonly droppedCount: number
}

/** Maps one `ProbeResult` onto the journal's flat probe-record shape. */
function probeInfoOf(input: JournalProbeInput): ProbeRecordInfo {
  const base = {
    serverName: input.serverName,
    initiator: {
      trigger: input.initiator.trigger,
      ...(input.initiator.adminName !== undefined ? { adminName: input.initiator.adminName } : {}),
    },
  }
  if (input.result.status === 'alive') {
    return {
      ...base,
      outcome: 'alive',
      probedVia: input.result.probedVia,
      initializeLatencyMs: input.result.initializeLatencyMs,
    }
  }
  // `message` arrives already redacted by the engine (names, never values);
  // the builder runs it through the standard redaction again anyway — the
  // journal has exactly one path in.
  return { ...base, outcome: input.result.status, error: input.result.message }
}

/**
 * Builds and writes the probe record, then flushes so the drop verdict is
 * known before returning: the orchestrator journals probes one at a time
 * and needs the outcome, not fire-and-forget.
 */
export async function journalProbe(input: JournalProbeInput): Promise<JournalProbeOutcome> {
  try {
    const record = buildProbeRecord({
      sessionId: PROBE_SESSION_ID,
      probe: probeInfoOf(input),
      ...(input.clock !== undefined ? { clock: input.clock } : {}),
      ...(input.knownSecrets !== undefined ? { knownSecrets: input.knownSecrets } : {}),
    })
    const sink = createJournalSink(PROBE_SESSION_ID, {
      ...(input.dir !== undefined ? { dir: input.dir } : {}),
      ...(input.sinkOptions ?? {}),
    })
    sink.write(record)
    await sink.close()
    const droppedCount = sink.droppedRecordCount()
    return { written: droppedCount === 0, droppedCount }
  } catch (error: unknown) {
    // Nothing here may take the probe down with it — a journal that cannot
    // be reached is a dropped record, reported the same way a failed commit
    // is (and, like the sink, said out loud on stderr rather than swallowed).
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[journal] failed to write a probe record: ${message}\n`)
    return { written: false, droppedCount: 1 }
  }
}
