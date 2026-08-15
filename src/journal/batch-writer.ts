import { JOURNAL_BATCH_MAX_DELAY_MS, JOURNAL_BATCH_MAX_RECORDS } from '../config.js'
import { isSqliteBusy } from '../store/sqlite.js'
import { insertRecordRows, openJournalDbShared, type JournalRecordRow } from './db.js'
import { SINK_RETRY_DELAY_MS } from './sink.js'

/**
 * The journal's write path (M4.5 wave 4, ADR-0006): records are buffered and
 * committed in batches, one transaction per batch, instead of one write per
 * record. `journal.db` runs `synchronous=FULL`, so a commit costs an fsync —
 * batching is what keeps that affordable at journal throughput.
 *
 * A batch commits when it reaches `maxRecords` OR `maxDelayMs` has elapsed
 * since its FIRST buffered record, whichever comes first, and `flushNow()`
 * commits on demand — that last one is the durability confirmation point the
 * fail-closed gate awaits, so it must mean "already committed", not "queued".
 *
 * Failure follows the sink's contract at batch granularity: one retry of the
 * whole batch, then every record in it settles as dropped, exactly once. The
 * writer itself never throws — a caller (the per-session sink facade) owns
 * counting drops and reporting them.
 */

/** How a caller learns what became of one enqueued record. */
export type SettleResult = { readonly ok: true } | { readonly ok: false; readonly error: unknown }

/**
 * @internal test-only seam replacing the old sink's `appendFileImpl`: the
 * whole batch commit, injectable so fault-injection tests can fail a write
 * without an unwritable database. Not for production use.
 */
export type CommitBatchImpl = (rows: readonly JournalRecordRow[]) => Promise<void>

export interface BatchWriterOptions {
  /** Records buffered before a commit is triggered. Defaults to JOURNAL_BATCH_MAX_RECORDS. */
  readonly maxRecords?: number
  /** Delay from the first buffered record to its commit. Defaults to JOURNAL_BATCH_MAX_DELAY_MS. */
  readonly maxDelayMs?: number
  /** Delay before the single retry of a failed batch. Defaults to SINK_RETRY_DELAY_MS. */
  readonly retryDelayMs?: number
  readonly commitBatchImpl?: CommitBatchImpl
}

export interface JournalBatchWriter {
  /**
   * Buffers one row. `onSettled` fires exactly once, when the row's batch has
   * committed or been dropped; anything it throws is swallowed, since a
   * consumer's callback must never break the commit queue. Never throws.
   */
  enqueue(row: JournalRecordRow, onSettled: (result: SettleResult) => void): void
  /**
   * Commits everything buffered now and resolves once every record enqueued
   * before the call has settled. Waits out a commit already in flight and
   * flushes whatever buffered meanwhile. Safe to call repeatedly.
   */
  flushNow(): Promise<void>
}

/** Matches the cross-process lock budget one document-store write gets (`policy/store.ts`). */
const JOURNAL_LOCK_TOTAL_WAIT_MS = 5_000
/** Cap of the exponential backoff between contended attempts. */
const RETRY_BACKOFF_CAP_MS = 32

/**
 * Writers are process-lifetime objects keyed by database path, mirroring the
 * shared connections they commit through. The cache serves ONLY callers that
 * pass no options: two callers with different batch bounds or a different
 * `commitBatchImpl` must not silently inherit whichever configuration got
 * there first, so any caller that configures anything gets its own instance.
 * Production callers pass nothing and share; tests and fault injection
 * configure and stay isolated.
 */
const sharedWriters = new Map<string, JournalBatchWriter>()

export function getBatchWriter(dbPath: string, opts?: BatchWriterOptions): JournalBatchWriter {
  if (opts !== undefined) return createBatchWriter(dbPath, opts)

  const shared = sharedWriters.get(dbPath)
  if (shared !== undefined) return shared

  const writer = createBatchWriter(dbPath, {})
  sharedWriters.set(dbPath, writer)
  return writer
}

/** One buffered record: its row and the callback owed exactly one settlement. */
interface BufferedRecord {
  readonly row: JournalRecordRow
  readonly onSettled: (result: SettleResult) => void
}

function createBatchWriter(dbPath: string, opts: BatchWriterOptions): JournalBatchWriter {
  const maxRecords = opts.maxRecords ?? JOURNAL_BATCH_MAX_RECORDS
  const maxDelayMs = opts.maxDelayMs ?? JOURNAL_BATCH_MAX_DELAY_MS
  // Read here rather than at module scope: `sink.ts` imports this module, so
  // a top-level read of its constant would hit the temporal dead zone when
  // the sink is the entry point of the cycle.
  const retryDelayMs = opts.retryDelayMs ?? SINK_RETRY_DELAY_MS
  const commitBatch = opts.commitBatchImpl ?? ((rows) => commitToDatabase(dbPath, rows))

  /**
   * Appended to in place rather than rebuilt per record: this is the hot path
   * (a journal record per proxied message) and the array never escapes — a
   * commit swaps it for a fresh one, so no other holder can observe it change.
   */
  let buffered: BufferedRecord[] = []
  let batchTimer: ReturnType<typeof setTimeout> | undefined
  /** Commits are chained here so batches never interleave and settle in order. */
  let queue: Promise<void> = Promise.resolve()

  function enqueue(row: JournalRecordRow, onSettled: (result: SettleResult) => void): void {
    buffered.push({ row, onSettled })
    if (buffered.length >= maxRecords) {
      commitBuffered()
      return
    }
    armTimer()
  }

  /** Armed by the FIRST buffered record only: the deadline belongs to the batch. */
  function armTimer(): void {
    if (batchTimer !== undefined) return
    batchTimer = setTimeout(() => {
      batchTimer = undefined
      commitBuffered()
    }, maxDelayMs)
    // The ONE timer here that may be unref'd, and only because nothing awaits
    // it: a pending batch must never hold a short-lived `connect`/`wrap`
    // process open, and every exit path (`flushNow`/`close`) bypasses this
    // timer by calling `commitBuffered()` synchronously. Contrast `delay()`.
    batchTimer.unref?.()
  }

  function disarmTimer(): void {
    if (batchTimer === undefined) return
    clearTimeout(batchTimer)
    batchTimer = undefined
  }

  /** Detaches the current buffer and chains its commit; a no-op when empty. */
  function commitBuffered(): void {
    disarmTimer()
    if (buffered.length === 0) return
    const batch = buffered
    buffered = []
    queue = queue.then(() => commitWithRetry(batch))
  }

  async function commitWithRetry(batch: readonly BufferedRecord[]): Promise<void> {
    const rows = batch.map((record) => record.row)
    try {
      await commitBatch(rows)
      settleAll(batch, { ok: true })
      return
    } catch {
      // fall through to the single retry below
    }

    await delay(retryDelayMs)

    try {
      await commitBatch(rows)
      settleAll(batch, { ok: true })
    } catch (error: unknown) {
      settleAll(batch, { ok: false, error })
    }
  }

  function settleAll(batch: readonly BufferedRecord[], result: SettleResult): void {
    for (const record of batch) {
      try {
        record.onSettled(result)
      } catch {
        // The consumer's callback must never break the commit queue.
      }
    }
  }

  async function flushNow(): Promise<void> {
    // One pass, not a drain loop: `enqueue` and `commitBuffered` are both
    // synchronous, so at this point the buffer holds exactly the records
    // enqueued before the call, and the promise captured right after chaining
    // them settles once they have. Waiting for the writer to go quiet instead
    // would let continuous traffic from another sink sharing this writer
    // starve the flush indefinitely — and the contract is only about records
    // enqueued BEFORE the call, never about ones that arrive after it.
    commitBuffered()
    const chained = queue
    await chained
  }

  return { enqueue, flushNow }
}

/** The production commit: one transaction per batch on the shared connection. */
async function commitToDatabase(dbPath: string, rows: readonly JournalRecordRow[]): Promise<void> {
  const handle = await openJournalDbShared(dbPath)
  await withBusyRetries(() => handle.transaction((db) => insertRecordRows(db, rows)))
}

/**
 * SOURCE: src/policy/store.ts:188-200 — duplicated rather than exported
 * across the state/journal boundary (12 lines against a widened surface on a
 * store this module has no business knowing about).
 *
 * `node:sqlite` waits for a contended writer lock SYNCHRONOUSLY, so the
 * per-statement window stays small (`journal/db.ts`) and the real waiting
 * happens here, off the event loop's back. `op` MUST tolerate being re-run:
 * a busy retry replays the whole transaction.
 */
async function withBusyRetries<R>(op: () => R): Promise<R> {
  const deadlineAt = performance.now() + JOURNAL_LOCK_TOTAL_WAIT_MS
  let attempt = 0
  for (;;) {
    try {
      return op()
    } catch (error: unknown) {
      if (!isSqliteBusy(error) || performance.now() >= deadlineAt) throw error
    }
    attempt += 1
    await delay(Math.min(2 ** attempt, RETRY_BACKOFF_CAP_MS) * Math.random())
  }
}

/**
 * The delay on the AWAITED commit path (the retry wait and the busy backoff),
 * deliberately ref'd. Node exits the moment the only pending work is an
 * unref'd timer, and an `await` on a promise settled by such a timer simply
 * never resumes — so an unref'd wait here would let a `connect`/`wrap`
 * process exit 0 in the middle of `flush()`/`close()`, silently discarding
 * records the durability contract says are already confirmed. Only the
 * passive batch-accumulation timer (`armTimer`) may be unref'd: nothing
 * awaits it, and the exit paths bypass it.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
