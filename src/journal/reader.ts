import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import type { JournalDirection, JournalRecord } from './record.js'

const JSONL_EXTENSION = '.jsonl'

export interface SessionSummary {
  readonly sessionId: string
  readonly firstTs: string
  readonly lastTs: string
  readonly messageCount: number
}

export interface ReadSessionOptions {
  readonly dir?: string
  readonly method?: string
  readonly direction?: JournalDirection
}

/**
 * Lists every session journal in `dir`, newest activity first. Malformed
 * lines and files whose every line is malformed are skipped, not fatal.
 * A missing directory yields an empty list rather than throwing.
 */
export async function listSessions(dir: string = JOURNAL_DIR): Promise<SessionSummary[]> {
  const files = await listJsonlFiles(dir)
  const summaries = await Promise.all(files.map((file) => summarizeSessionFile(dir, file)))
  const nonEmpty = summaries.filter((summary): summary is SessionSummary => summary !== null)
  return [...nonEmpty].sort((a, b) => b.lastTs.localeCompare(a.lastTs))
}

/**
 * Reads one session's records, optionally filtered by method and/or
 * direction. A missing session file or directory yields an empty array.
 */
export async function readSession(
  sessionId: string,
  options: ReadSessionOptions = {},
): Promise<JournalRecord[]> {
  const dir = options.dir ?? JOURNAL_DIR
  const records = await readRecordsFromFile(join(dir, `${sessionId}${JSONL_EXTENSION}`))
  return records.filter((record) => matchesFilters(record, options))
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries.filter((name) => name.endsWith(JSONL_EXTENSION))
  } catch (error) {
    if (isEnoent(error)) {
      return []
    }
    throw error
  }
}

async function summarizeSessionFile(dir: string, fileName: string): Promise<SessionSummary | null> {
  const sessionId = fileName.slice(0, -JSONL_EXTENSION.length)
  const records = await readRecordsFromFile(join(dir, fileName))
  const firstRecord = records[0]
  const lastRecord = records[records.length - 1]
  if (!firstRecord || !lastRecord) {
    return null
  }

  return {
    sessionId,
    firstTs: firstRecord.ts,
    lastTs: lastRecord.ts,
    messageCount: records.length,
  }
}

function matchesFilters(record: JournalRecord, options: ReadSessionOptions): boolean {
  if (options.method !== undefined && record.method !== options.method) {
    return false
  }
  if (options.direction !== undefined && record.direction !== options.direction) {
    return false
  }
  return true
}

async function readRecordsFromFile(filePath: string): Promise<JournalRecord[]> {
  const content = await readFileOrEmpty(filePath)
  const lines = content.split(NEWLINE).filter((line) => line.trim().length > 0)
  return lines.reduce<JournalRecord[]>((records, line) => {
    const parsed = tryParseRecord(line)
    return parsed ? [...records, parsed] : records
  }, [])
}

const NEWLINE = '\n'

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (isEnoent(error)) {
      return ''
    }
    throw error
  }
}

function tryParseRecord(line: string): JournalRecord | null {
  try {
    return JSON.parse(line) as JournalRecord
  } catch {
    return null
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
