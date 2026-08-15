import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { LIST_SESSIONS_CONCURRENCY, JOURNAL_DIR } from '../config.js'
import { mapWithConcurrency } from './concurrency.js'
import { dbHasSession, dbSessionSummaries, type DbSessionSummary } from './db-read.js'
import { dbReadSessionRecords } from './db-read-session.js'
import { isShadowedByDb, openJournalDbIfPresent } from './read-routing.js'
import type { JournalDirection, JournalRecord } from './record.js'
import { assertValidSessionId } from './session-id.js'

const JSONL_EXTENSION = '.jsonl'

/** Directions a journal record can carry; exported so callers (e.g. the CLI) can validate untrusted input against it. */
export const JOURNAL_DIRECTIONS: readonly JournalDirection[] = [
  'client→server',
  'server→client',
  'server-stderr',
]

/** Kinds a journal record can carry; exported so callers (e.g. the CLI) can validate untrusted input against it. */
export const JOURNAL_KINDS: readonly string[] = [
  'request',
  'response',
  'notification',
  'invalid',
  'stderr',
  'decision',
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
  readonly kind?: string
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
 *
 * Both carriers are listed: `journal.db`'s sessions (one indexed aggregate)
 * and the legacy `*.jsonl` files it does not already speak for. A database
 * session with no rows left — an import marker alone — is omitted for the
 * same reason a file with no readable record is: there is nothing to show.
 */
export async function listSessions(dir: string = JOURNAL_DIR): Promise<SessionSummary[]> {
  const handle = await openJournalDbIfPresent(dir)
  const fromDb = handle === null ? [] : dbSessionSummaries(handle).map(toSessionSummary)
  const isShadowed = isShadowedByDb(handle)
  const files = (await listJsonlFiles(dir)).filter(
    (file) => !isShadowed(sessionIdOfFileName(file)),
  )
  const summaries = await mapWithConcurrency(files, LIST_SESSIONS_CONCURRENCY, (file) =>
    summarizeSessionFile(dir, file),
  )
  const nonEmpty = summaries.filter((summary): summary is SessionSummary => summary !== null)
  // A stable sort, so on the (per-run-ULID-impossible) tie of two equal
  // `lastTs` the database's entry stays ahead of the file's.
  return [...fromDb, ...nonEmpty].sort((a, b) => b.lastTs.localeCompare(a.lastTs))
}

/** The database's summary in the shape this module's callers already print. */
function toSessionSummary(summary: DbSessionSummary): SessionSummary {
  return {
    sessionId: summary.sessionId,
    firstTs: summary.firstTs,
    lastTs: summary.lastTs,
    messageCount: summary.count,
    skippedLineCount: summary.skippedLineCount,
  }
}

/** True when `value` is one of the journal's recognized traffic directions. */
export function isValidJournalDirection(value: string): value is JournalDirection {
  return (JOURNAL_DIRECTIONS as readonly string[]).includes(value)
}

/** True when `value` is one of the journal's recognized record kinds. */
export function isValidJournalKind(value: string): boolean {
  return JOURNAL_KINDS.includes(value)
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

/**
 * Same as `readSession`, but also reports how many lines were skipped.
 *
 * A session `journal.db` is the carrier for is read from there, whole and
 * uncapped — this is the one-shot print, so a page limit would be silent
 * truncation. The file arm below, including its own frozen shape check, is
 * untouched and still answers for everything else.
 */
export async function readSessionWithStats(
  sessionId: string,
  options: ReadSessionOptions = {},
): Promise<SessionReadResult> {
  assertValidSessionId(sessionId)
  const dir = options.dir ?? JOURNAL_DIR
  const handle = await openJournalDbIfPresent(dir)
  if (handle !== null && dbHasSession(handle, sessionId)) {
    return dbReadSessionRecords(handle, sessionId, options)
  }

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

/** The session a journal file name stands for (the name minus its extension). */
function sessionIdOfFileName(fileName: string): string {
  return fileName.slice(0, -JSONL_EXTENSION.length)
}

async function summarizeSessionFile(dir: string, fileName: string): Promise<SessionSummary | null> {
  const sessionId = sessionIdOfFileName(fileName)
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
  if (options.kind !== undefined && record.kind !== options.kind) {
    return false
  }
  return true
}

interface FileReadResult {
  readonly records: JournalRecord[]
  readonly skippedLineCount: number
}

/**
 * Reads one journal file line-by-line via a stream, rather than loading it
 * whole: a long-running session's journal can exceed Node's max string
 * length, and readline lets the file be processed without ever holding more
 * than a few lines in memory at once. A missing file yields an empty result
 * rather than throwing.
 */
async function readRecordsFromFile(filePath: string): Promise<FileReadResult> {
  const records: JournalRecord[] = []
  let skippedLineCount = 0

  try {
    const lines = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of lines) {
      if (line.trim().length === 0) {
        continue
      }
      const parsed = tryParseRecord(line)
      if (parsed === null) {
        skippedLineCount += 1
        continue
      }
      records.push(parsed)
    }
  } catch (error) {
    if (isEnoent(error)) {
      return { records: [], skippedLineCount: 0 }
    }
    throw error
  }

  return { records, skippedLineCount }
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
  const kind = value['kind']
  return (
    typeof value['id'] === 'string' &&
    isNonEmptyString(value['ts']) &&
    typeof value['sessionId'] === 'string' &&
    isOneOf(value['direction'], JOURNAL_DIRECTIONS) &&
    isOneOf(kind, JOURNAL_KINDS) &&
    'payload' in value &&
    isOptionalString(value['method']) &&
    isOptionalNumber(value['durationMs']) &&
    (kind !== 'decision' || isDecisionInfoShape(value['decision']))
  )
}

/**
 * Minimal shape check for a `decision`-kind record's `decision` field: just
 * enough to make the reader's and CLI's use of `outcome`/`rule`/`toolName`
 * safe. Old, pre-M2 journal lines never have `kind: 'decision'`, so this
 * check never runs against them -- backward compatibility is preserved.
 */
function isDecisionInfoShape(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false
  }
  return (
    isNonEmptyString(value['outcome']) &&
    isNonEmptyString(value['rule']) &&
    isNonEmptyString(value['toolName'])
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
