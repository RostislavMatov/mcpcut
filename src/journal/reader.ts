import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import type { JournalDirection, JournalRecord } from './record.js'
import { assertValidSessionId } from './session-id.js'

const JSONL_EXTENSION = '.jsonl'
const NEWLINE = '\n'

const JOURNAL_DIRECTIONS: readonly string[] = ['client→server', 'server→client', 'server-stderr']
const JOURNAL_KINDS: readonly string[] = [
  'request',
  'response',
  'notification',
  'invalid',
  'stderr',
]

export interface SessionSummary {
  readonly sessionId: string
  readonly firstTs: string
  readonly lastTs: string
  readonly messageCount: number
  /** Lines that were not readable as journal records and were skipped. */
  readonly skippedLineCount: number
}

export interface ReadSessionOptions {
  readonly dir?: string
  readonly method?: string
  readonly direction?: JournalDirection
}

/** Records matching the filters, plus how many lines had to be skipped. */
export interface SessionReadResult {
  readonly records: readonly JournalRecord[]
  readonly skippedLineCount: number
}

/**
 * Lists every session journal in `dir`, newest activity first. Lines that are
 * not valid journal records — malformed JSON *or* well-formed JSON of the
 * wrong shape — are skipped, not fatal, and files with no readable record are
 * omitted. A missing directory yields an empty list rather than throwing.
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
 * Throws if `sessionId` is not a safe file name.
 */
export async function readSession(
  sessionId: string,
  options: ReadSessionOptions = {},
): Promise<JournalRecord[]> {
  const { records } = await readSessionWithStats(sessionId, options)
  return [...records]
}

/** Same as `readSession`, but also reports how many lines were skipped. */
export async function readSessionWithStats(
  sessionId: string,
  options: ReadSessionOptions = {},
): Promise<SessionReadResult> {
  assertValidSessionId(sessionId)
  const dir = options.dir ?? JOURNAL_DIR
  const { records, skippedLineCount } = await readRecordsFromFile(
    join(dir, `${sessionId}${JSONL_EXTENSION}`),
  )
  return {
    records: records.filter((record) => matchesFilters(record, options)),
    skippedLineCount,
  }
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
  const { records, skippedLineCount } = await readRecordsFromFile(join(dir, fileName))
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
    skippedLineCount,
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

interface FileReadResult {
  readonly records: JournalRecord[]
  readonly skippedLineCount: number
}

async function readRecordsFromFile(filePath: string): Promise<FileReadResult> {
  const content = await readFileOrEmpty(filePath)
  const lines = content.split(NEWLINE).filter((line) => line.trim().length > 0)

  const records: JournalRecord[] = []
  let skippedLineCount = 0
  for (const line of lines) {
    const parsed = tryParseRecord(line)
    if (parsed === null) {
      skippedLineCount += 1
      continue
    }
    records.push(parsed)
  }
  return { records, skippedLineCount }
}

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

/** Parses one JSONL line, returning null unless it is a well-shaped record. */
function tryParseRecord(line: string): JournalRecord | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return isJournalRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Journal files are untrusted input: they may be hand-edited, truncated
 * mid-write, or contain lines from another tool. Every field the reader and
 * its callers rely on is checked before a line is accepted as a record.
 */
function isJournalRecord(value: unknown): value is JournalRecord {
  if (!isPlainObject(value)) {
    return false
  }
  return (
    typeof value['id'] === 'string' &&
    isNonEmptyString(value['ts']) &&
    typeof value['sessionId'] === 'string' &&
    isOneOf(value['direction'], JOURNAL_DIRECTIONS) &&
    isOneOf(value['kind'], JOURNAL_KINDS) &&
    'payload' in value &&
    isOptionalString(value['method']) &&
    isOptionalNumber(value['durationMs'])
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number'
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
