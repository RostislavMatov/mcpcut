import { appendFile, chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { JOURNAL_DIR, JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../config.js'
import type { JournalRecord } from './record.js'
import { assertValidSessionId } from './session-id.js'

const NEWLINE = '\n'
const JSONL_EXTENSION = '.jsonl'

/** Default delay before the single retry after a failed append. */
export const SINK_RETRY_DELAY_MS = 100

/** Narrow shape of node:fs/promises' appendFile, for test fault injection. */
type AppendFileImpl = (
  path: string,
  data: string,
  options: { readonly encoding: 'utf8'; readonly mode: number },
) => Promise<void>

export interface JournalSinkOptions {
  /** Directory holding per-session JSONL files. Defaults to JOURNAL_DIR. */
  readonly dir?: string
  /**
   * Called after a record's retry also fails, once per dropped record.
   * `droppedCount` is the sink's running total including this record.
   * Errors thrown by this callback are swallowed: they must never break
   * subsequent writes.
   */
  readonly onWriteError?: (error: unknown, droppedCount: number) => void
  /** Delay before the single retry after a failed append. Defaults to SINK_RETRY_DELAY_MS. */
  readonly retryDelayMs?: number
  /**
   * @internal test-only seam to inject a faulty fs.appendFile for fault
   * injection. Not for production use.
   */
  readonly appendFileImpl?: AppendFileImpl
}

export interface JournalSink {
  /**
   * Fire-and-forget append of one record as a JSONL line. Writes are
   * serialized internally so concurrent calls never interleave. A failed
   * append is retried once after `retryDelayMs`; if the retry also fails the
   * record is dropped (counted in droppedRecordCount()), logged to stderr,
   * and reported via `onWriteError` if provided. This never throws or rejects.
   * After close() this is a no-op that warns once.
   */
  readonly write: (record: JournalRecord) => void
  /**
   * Resolves once every write queued so far has settled (success or dropped),
   * without closing the sink. Safe to call repeatedly, and safe to write
   * more records after it resolves.
   */
  readonly flush: () => Promise<void>
  /**
   * Resolves once every write queued so far has settled (success or logged
   * failure) and marks the sink closed. Idempotent.
   */
  readonly close: () => Promise<void>
  /** Total number of records dropped after their retry also failed. */
  readonly droppedRecordCount: () => number
}

/**
 * Creates an append-only JSONL sink for one proxy session's journal file.
 * Throws if `sessionId` is not a safe file name.
 *
 * The journal holds redacted-but-sensitive traffic, so the directory is
 * created 0700 and files 0600, and the directory is created exactly once per
 * sink rather than on every append.
 */
export function createJournalSink(sessionId: string, opts: JournalSinkOptions = {}): JournalSink {
  assertValidSessionId(sessionId)
  const dir = opts.dir ?? JOURNAL_DIR
  const filePath = join(dir, `${sessionId}${JSONL_EXTENSION}`)
  const retryDelayMs = opts.retryDelayMs ?? SINK_RETRY_DELAY_MS
  const doAppend: AppendFileImpl = opts.appendFileImpl ?? appendFile
  const onWriteError = opts.onWriteError

  let queue: Promise<void> = Promise.resolve()
  let dirReady: Promise<unknown> | undefined
  let isClosed = false
  let hasWarnedAfterClose = false
  let droppedCount = 0

  /**
   * Memoized so concurrent and subsequent writes share one mkdir. The chmod
   * covers directories that already existed: mkdir's `mode` only applies on
   * creation, so without it a pre-existing journal dir would keep whatever
   * permissions it was created with.
   */
  function ensureDir(): Promise<unknown> {
    dirReady ??= mkdir(dir, { recursive: true, mode: JOURNAL_DIR_MODE }).then(() =>
      chmod(dir, JOURNAL_DIR_MODE),
    )
    return dirReady
  }

  async function appendRecord(record: JournalRecord): Promise<void> {
    await ensureDir()
    await doAppend(filePath, JSON.stringify(record) + NEWLINE, {
      encoding: 'utf8',
      mode: JOURNAL_FILE_MODE,
    })
  }

  async function appendWithRetry(record: JournalRecord): Promise<void> {
    try {
      await appendRecord(record)
      return
    } catch {
      // fall through to the single retry below
    }

    await delay(retryDelayMs)

    try {
      await appendRecord(record)
    } catch (error: unknown) {
      handleFinalFailure(error)
    }
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

  function write(record: JournalRecord): void {
    if (isClosed) {
      warnWriteAfterClose()
      return
    }
    queue = queue.then(() => appendWithRetry(record))
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
    await queue
  }

  async function close(): Promise<void> {
    isClosed = true
    await queue
  }

  return {
    write,
    flush,
    close,
    droppedRecordCount: () => droppedCount,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function logWriteError(sessionId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`[journal] failed to write session "${sessionId}": ${message}${NEWLINE}`)
}
