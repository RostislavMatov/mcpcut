import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { JOURNAL_DIR, JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../config.js'
import type { JournalRecord } from './record.js'
import { assertValidSessionId } from './session-id.js'

const NEWLINE = '\n'
const JSONL_EXTENSION = '.jsonl'

export interface JournalSinkOptions {
  /** Directory holding per-session JSONL files. Defaults to JOURNAL_DIR. */
  readonly dir?: string
}

export interface JournalSink {
  /**
   * Fire-and-forget append of one record as a JSONL line. Writes are
   * serialized internally so concurrent calls never interleave. Failures
   * are caught and logged to stderr; this never throws or rejects.
   * After close() this is a no-op that warns once.
   */
  readonly write: (record: JournalRecord) => void
  /**
   * Resolves once every write queued so far has settled (success or logged
   * failure) and marks the sink closed. Idempotent.
   */
  readonly close: () => Promise<void>
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

  let queue: Promise<void> = Promise.resolve()
  let dirReady: Promise<unknown> | undefined
  let isClosed = false
  let hasWarnedAfterClose = false

  /** Memoized so concurrent and subsequent writes share one mkdir. */
  function ensureDir(): Promise<unknown> {
    dirReady ??= mkdir(dir, { recursive: true, mode: JOURNAL_DIR_MODE })
    return dirReady
  }

  async function appendRecord(record: JournalRecord): Promise<void> {
    await ensureDir()
    await appendFile(filePath, JSON.stringify(record) + NEWLINE, {
      encoding: 'utf8',
      mode: JOURNAL_FILE_MODE,
    })
  }

  function write(record: JournalRecord): void {
    if (isClosed) {
      warnWriteAfterClose()
      return
    }
    queue = queue.then(() => appendRecord(record)).catch((error: unknown) => {
      logWriteError(sessionId, error)
    })
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

  async function close(): Promise<void> {
    isClosed = true
    await queue
  }

  return { write, close }
}

function logWriteError(sessionId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`[journal] failed to write session "${sessionId}": ${message}${NEWLINE}`)
}
