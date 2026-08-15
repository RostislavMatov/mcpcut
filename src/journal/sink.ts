import { JOURNAL_DIR } from '../config.js'
import { getBatchWriter, type CommitBatchImpl } from './batch-writer.js'
import { journalDbPathFor, type JournalRecordRow } from './db.js'
import type { JournalRecord } from './record.js'
import { assertValidSessionId } from './session-id.js'

const NEWLINE = '\n'

/** Default delay before the single retry after a failed commit. */
export const SINK_RETRY_DELAY_MS = 100

export type { CommitBatchImpl }

export interface JournalSinkOptions {
  /** Journal directory holding `journal.db`. Defaults to JOURNAL_DIR. */
  readonly dir?: string
  /**
   * Called after a record's retry also fails, once per dropped record.
   * `droppedCount` is the sink's running total including this record.
   * Errors thrown by this callback are swallowed: they must never break
   * subsequent writes.
   */
  readonly onWriteError?: (error: unknown, droppedCount: number) => void
  /**
   * Delay before the single retry of the batch a record travelled in.
   * Defaults to SINK_RETRY_DELAY_MS.
   */
  readonly retryDelayMs?: number
  /**
   * @internal test-only seam to inject a faulty batch commit for fault
   * injection. Not for production use.
   */
  readonly commitBatchImpl?: CommitBatchImpl
}

export interface JournalSink {
  /**
   * Fire-and-forget append of one record. Records are buffered and committed
   * in batches by the per-process writer, so concurrent calls never
   * interleave and land in call order. A failed commit is retried once after
   * `retryDelayMs`; if the retry also fails every record in the batch is
   * dropped (counted in droppedRecordCount()), logged to stderr, and
   * reported via `onWriteError` if provided. This never throws or rejects.
   * After close() this is a no-op that warns once.
   */
  readonly write: (record: JournalRecord) => void
  /**
   * Resolves once every write queued so far has settled (committed or
   * dropped) — the durability confirmation point the fail-closed gate awaits.
   * Safe to call repeatedly, and safe to write more records after it
   * resolves.
   */
  readonly flush: () => Promise<void>
  /**
   * Resolves once every write queued so far has settled (committed or logged
   * failure) and marks the sink closed. Idempotent.
   */
  readonly close: () => Promise<void>
  /** Total number of records dropped after their batch's retry also failed. */
  readonly droppedRecordCount: () => number
}

/**
 * Creates an append-only sink for one proxy session's journal records
 * (M4.5 wave 4, ADR-0006). Throws if `sessionId` is not a safe name.
 *
 * The sink itself is a thin per-session facade: it extracts the row a record
 * becomes and hands it to the journal directory's shared batch writer, which
 * owns buffering, transactions and retry. Durability, file modes and the
 * directory belong to `journal.db`'s adapter now, not to this module.
 *
 * `sessionId` is still validated here even though it travels as a bound SQL
 * parameter: it also names the session across the CLI and UI surfaces, and
 * defence in depth is cheaper than reasoning about every consumer.
 */
export function createJournalSink(sessionId: string, opts: JournalSinkOptions = {}): JournalSink {
  assertValidSessionId(sessionId)
  const journalDir = opts.dir ?? JOURNAL_DIR
  const dbPath = journalDbPathFor(journalDir)
  const onWriteError = opts.onWriteError

  /**
   * Production sinks configure nothing and therefore share one writer per
   * database — that sharing is the point of batching across a `serve`
   * daemon's many sessions. A caller that configures anything gets its own
   * instance instead, per the writer's cache rule.
   */
  const writerOptions = configuredWriterOptions(opts)
  const writer =
    writerOptions === undefined ? getBatchWriter(dbPath) : getBatchWriter(dbPath, writerOptions)

  /** Settlements this sink still owes flush(); a settled record removes itself. */
  const outstanding = new Set<Promise<void>>()
  let isClosed = false
  let hasWarnedAfterClose = false
  let droppedCount = 0

  function write(record: JournalRecord): void {
    if (isClosed) {
      warnWriteAfterClose()
      return
    }

    const settled = new Promise<void>((resolve) => {
      writer.enqueue(rowOf(sessionId, record), (result) => {
        try {
          if (!result.ok) handleFinalFailure(result.error)
        } finally {
          resolve()
        }
      })
    })
    outstanding.add(settled)
    void settled.then(() => outstanding.delete(settled))
  }

  function handleFinalFailure(error: unknown): void {
    droppedCount += 1
    logWriteError(sessionId, error)
    if (!onWriteError) {
      return
    }
    try {
      onWriteError(error, droppedCount)
    } catch {
      // The consumer's callback must never break the write queue.
    }
  }

  function warnWriteAfterClose(): void {
    if (hasWarnedAfterClose) {
      return
    }
    hasWarnedAfterClose = true
    process.stderr.write(
      `[journal] dropped a record for session "${sessionId}": the sink is closed${NEWLINE}`,
    )
  }

  async function flush(): Promise<void> {
    // Snapshot first: only records enqueued BEFORE the call are promised.
    const pending = [...outstanding]
    await writer.flushNow()
    await Promise.all(pending)
  }

  async function close(): Promise<void> {
    isClosed = true
    await flush()
  }

  return {
    write,
    flush,
    close,
    droppedRecordCount: () => droppedCount,
  }
}

/**
 * The writer options a sink passes on, or undefined when it configures
 * nothing — the difference between getting the shared writer and a dedicated
 * one, so it is computed rather than defaulted.
 */
function configuredWriterOptions(
  opts: JournalSinkOptions,
): { readonly retryDelayMs?: number; readonly commitBatchImpl?: CommitBatchImpl } | undefined {
  if (opts.retryDelayMs === undefined && opts.commitBatchImpl === undefined) return undefined
  return {
    ...(opts.retryDelayMs !== undefined ? { retryDelayMs: opts.retryDelayMs } : {}),
    ...(opts.commitBatchImpl !== undefined ? { commitBatchImpl: opts.commitBatchImpl } : {}),
  }
}

/**
 * The record's row: `doc` carries the whole record unchanged (the source of
 * truth on the way out), the other columns are denormalized copies that only
 * keep indexed scans narrow.
 */
function rowOf(sessionId: string, record: JournalRecord): JournalRecordRow {
  return {
    sessionId,
    recordId: record.id,
    ts: record.ts,
    direction: record.direction,
    kind: record.kind,
    method: record.method ?? null,
    doc: JSON.stringify(record),
  }
}

function logWriteError(sessionId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`[journal] failed to write session "${sessionId}": ${message}${NEWLINE}`)
}
