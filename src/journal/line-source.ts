import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { JOURNAL_DIRECTIONS, JOURNAL_KINDS } from './reader.js'
import type { JournalRecord } from './record.js'
import { isValidSessionId } from './session-id.js'

/**
 * The line-and-file layer under the journal's read side: how a JSONL file is
 * streamed, how a line becomes a record, and how the journal directory is
 * enumerated. `search.ts` (paging, filters, cross-session walks) and
 * `index-cache.ts` (summaries) both sit on this and share one filesystem seam,
 * so a test can count exactly what a query read.
 *
 * `reader.ts` deliberately keeps its own copy of the shape check: it is frozen
 * by the M1/M2 test gate, and a shared edit there would change behaviour tests
 * that are not allowed to move.
 */

const JSONL_EXTENSION = '.jsonl'

/** Size and modification time of one journal file. */
export interface JournalFileStat {
  readonly size: number
  readonly mtimeMs: number
}

/**
 * Every filesystem and clock touch of the journal read side, injectable so
 * tests can count reads and drive scan deadlines without real files or real
 * time.
 */
export interface JournalReadDeps {
  /** Yields the file's lines; yields nothing when the file is missing. */
  readonly readLines: (filePath: string) => AsyncIterable<string>
  /** Journal file names in `dir`; empty when the directory is missing. */
  readonly listFiles: (dir: string) => Promise<readonly string[]>
  /** Size and mtime, or null when the file is missing. */
  readonly statFile: (filePath: string) => Promise<JournalFileStat | null>
  /** Clock used for scan deadlines. */
  readonly now: () => number
}

/** Real filesystem and clock implementation of {@link JournalReadDeps}. */
export const defaultJournalReadDeps: JournalReadDeps = {
  readLines: readLinesFrom,
  listFiles: listJournalFiles,
  statFile: statJournalFile,
  now: () => Date.now(),
}

/** Fills in the real implementation for every dep a caller did not override. */
export function resolveJournalReadDeps(overrides: Partial<JournalReadDeps>): JournalReadDeps {
  return { ...defaultJournalReadDeps, ...overrides }
}

/** Path of one session's journal file inside `dir`. */
export function journalPath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}${JSONL_EXTENSION}`)
}

/** The session id a journal file name stands for, or null if it is not one. */
export function sessionIdOf(fileName: string): string | null {
  if (!fileName.endsWith(JSONL_EXTENSION)) {
    return null
  }
  const sessionId = fileName.slice(0, -JSONL_EXTENSION.length)
  return isValidSessionId(sessionId) ? sessionId : null
}

/** One journal file, as found on disk. */
export interface SessionFile {
  readonly fileName: string
  readonly sessionId: string
  readonly mtimeMs: number
}

/**
 * Journal files in `dir`, most recently modified first — the order a search
 * walks them in, because the newest traffic is what an operator is looking for
 * when a scan has to stop early. Names that are not usable session ids are
 * ignored: the directory is untrusted input, and a name this plane never wrote
 * is not this plane's journal.
 */
export async function listSessionFilesNewestFirst(
  dir: string,
  deps: JournalReadDeps,
): Promise<readonly SessionFile[]> {
  const fileNames = await deps.listFiles(dir)
  const stated = await Promise.all(
    fileNames.map(async (fileName): Promise<SessionFile | null> => {
      const sessionId = sessionIdOf(fileName)
      if (sessionId === null) {
        return null
      }
      const info = await deps.statFile(join(dir, fileName))
      return info === null ? null : { fileName, sessionId, mtimeMs: info.mtimeMs }
    }),
  )
  return stated
    .filter((file): file is SessionFile => file !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.fileName.localeCompare(a.fileName))
}

/** True for a line that carries no content and so is not a skipped record. */
export function isBlankLine(line: string): boolean {
  return line.length === 0 || line.trim().length === 0
}

/**
 * Parses one JSONL line into a record, or null when the line is unreadable.
 * Journal files may be hand-edited, truncated mid-write or hold another tool's
 * lines, so every field this layer and its callers rely on is verified before
 * the line becomes a record.
 */
export function parseJournalLine(line: string): JournalRecord | null {
  if (isBlankLine(line)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(line)
    return isJournalRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

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
    (kind !== 'decision' || isDecisionShape(value['decision']))
  )
}

/**
 * Minimal shape check for a `decision` record's `decision` field: enough to
 * make the outcome/rule/toolName filters safe. Pre-M2 lines never carry
 * `kind: 'decision'`, so this never runs against them.
 */
function isDecisionShape(value: unknown): boolean {
  return (
    isPlainObject(value) &&
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

/**
 * Streams a file's lines. A journal can exceed Node's max string length, so it
 * is never read whole; the stream is destroyed in `finally`, which is what
 * makes an early `break` in the caller release the file descriptor instead of
 * leaking it for the life of the process.
 */
async function* readLinesFrom(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      yield line
    }
  } catch (error) {
    if (!isEnoent(error)) {
      throw error
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

async function listJournalFiles(dir: string): Promise<readonly string[]> {
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

async function statJournalFile(filePath: string): Promise<JournalFileStat | null> {
  try {
    const info = await stat(filePath)
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch (error) {
    if (isEnoent(error)) {
      return null
    }
    throw error
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
