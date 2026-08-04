import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import type { JournalRecord } from './record.js'

const NEWLINE = '\n'

export interface JournalSinkOptions {
  /** Directory holding per-session JSONL files. Defaults to JOURNAL_DIR. */
  readonly dir?: string
}

export interface JournalSink {
  /**
   * Fire-and-forget append of one record as a JSONL line. Writes are
   * serialized internally so concurrent calls never interleave. Failures
   * are caught and logged to stderr; this never throws or rejects.
   */
  readonly write: (record: JournalRecord) => void
  /** Resolves once every write queued so far has settled (success or logged failure). */
  readonly close: () => Promise<void>
}

/** Creates an append-only JSONL sink for one proxy session's journal file. */
export function createJournalSink(sessionId: string, opts: JournalSinkOptions = {}): JournalSink {
  const dir = opts.dir ?? JOURNAL_DIR
  const filePath = join(dir, `${sessionId}.jsonl`)
  let queue: Promise<void> = Promise.resolve()

  function write(record: JournalRecord): void {
    queue = queue.then(() => appendRecord(filePath, record)).catch((error: unknown) => {
      logWriteError(sessionId, error)
    })
  }

  async function close(): Promise<void> {
    await queue
  }

  return { write, close }
}

/** Ensures the journal directory exists, then appends one JSONL line. */
async function appendRecord(filePath: string, record: JournalRecord): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, JSON.stringify(record) + NEWLINE, 'utf8')
}

function logWriteError(sessionId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`[journal] failed to write session "${sessionId}": ${message}${NEWLINE}`)
}
