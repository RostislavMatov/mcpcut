import { parseArgs } from 'node:util'
import {
  isValidJournalDirection,
  isValidJournalKind,
  JOURNAL_DIRECTIONS,
  JOURNAL_KINDS,
  listSessions,
  readSessionWithStats,
} from '../journal/reader.js'
import { formatRecordsJson, formatRecordsReadable, formatSessionsTable } from './session-view.js'

/**
 * `sessions` and `show` — journal read commands, moved verbatim out of the
 * argv dispatcher (cli.ts) when M3 grew the command set past its size budget.
 * Same behavior, same tests (tests/cli/dispatch.test.ts drives them through
 * dispatch()).
 */

/** Minimal writable-stream shape these commands need. */
export interface JournalCliWritable {
  write(chunk: string): unknown
}

export interface JournalCliIo {
  readonly stdout: JournalCliWritable
  readonly stderr: JournalCliWritable
}

/** Routes `sessions` / `show` for the dispatcher. */
export async function runJournalCommandGroup(
  command: 'sessions' | 'show',
  rest: readonly string[],
  io: JournalCliIo,
  journalDir: string | undefined,
  usage: string,
): Promise<number> {
  if (command === 'sessions') return runSessionsCommand(io, journalDir)
  return runShowCommand(rest, io, journalDir, usage)
}

export async function runSessionsCommand(
  io: JournalCliIo,
  journalDir: string | undefined,
): Promise<number> {
  const sessions = await listSessions(journalDir)
  io.stdout.write(sessions.length === 0 ? 'No sessions found.\n' : formatSessionsTable(sessions))
  return 0
}

/**
 * Parses `show <sessionId> [--method X] [--direction Y] [--json]` and prints
 * its records. Options are parsed from the *whole* argument list before the
 * positional sessionId is read, so `show --json 01ABC` cannot silently treat
 * `--json` as the session id.
 */
export async function runShowCommand(
  showArgs: readonly string[],
  io: JournalCliIo,
  journalDir: string | undefined,
  usage: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...showArgs],
    options: {
      method: { type: 'string' },
      direction: { type: 'string' },
      kind: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  })

  const sessionId = positionals[0]
  if (sessionId === undefined) {
    io.stderr.write(`Missing <sessionId> in show command.\n\n${usage}`)
    return 1
  }

  const direction = values.direction
  if (direction !== undefined && !isValidJournalDirection(direction)) {
    io.stderr.write(
      `Invalid --direction "${direction}". Allowed values: ${JOURNAL_DIRECTIONS.join(', ')}\n\n${usage}`,
    )
    return 1
  }

  const kind = values.kind
  if (kind !== undefined && !isValidJournalKind(kind)) {
    io.stderr.write(`Invalid --kind "${kind}". Allowed values: ${JOURNAL_KINDS.join(', ')}\n\n${usage}`)
    return 1
  }

  const { records, skippedLineCount } = await readSessionWithStats(sessionId, {
    ...(journalDir !== undefined ? { dir: journalDir } : {}),
    ...(values.method !== undefined ? { method: values.method } : {}),
    ...(direction !== undefined ? { direction } : {}),
    ...(kind !== undefined ? { kind } : {}),
  })

  io.stdout.write(values.json === true ? formatRecordsJson(records) : formatRecordsReadable(records))
  if (skippedLineCount > 0) {
    io.stderr.write(`Skipped ${skippedLineCount} unreadable journal line(s).\n`)
  }
  return 0
}
