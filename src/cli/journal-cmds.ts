import { parseArgs } from 'node:util'
import { JOURNAL_DIR } from '../config.js'
import { listUnimportedLegacySessions } from '../journal/import.js'
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
 *
 * M4.5 wave 5 (task 6) adds the un-imported-legacy-file hint: `sessions`
 * nudges toward `mcpcut migrate` whenever any exist; `show` only does so
 * when the session it was asked for is itself one of them (targeted, not
 * noisy). The probe is best-effort — an unreadable directory degrades to no
 * hint rather than failing the command, which already has its own answer.
 */

/**
 * `show`'s own synopsis. It used to be handed the whole `cli/usage.ts` table
 * and print it on every argument error, which pushed the list of allowed
 * `--kind`/`--direction` values — the one thing the operator needed to read —
 * off the top of the terminal (user-journey smoke 2026-09-18, UX-6). The
 * allowed values are spliced in from the reader's own vocabulary, so a new
 * kind cannot make this text stale.
 */
const SHOW_USAGE =
  'Usage: mcpcut show <sessionId> [--method <m>] [--direction <d>] [--kind <k>] [--json]\n' +
  `  --direction  ${JOURNAL_DIRECTIONS.join(' | ')}\n` +
  `  --kind       ${JOURNAL_KINDS.join(' | ')}\n` +
  'See `mcpcut --help` for every command.\n'

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
): Promise<number> {
  if (command === 'sessions') return runSessionsCommand(io, journalDir)
  return runShowCommand(rest, io, journalDir)
}

export async function runSessionsCommand(
  io: JournalCliIo,
  journalDir: string | undefined,
): Promise<number> {
  const sessions = await listSessions(journalDir)
  io.stdout.write(sessions.length === 0 ? 'No sessions found.\n' : formatSessionsTable(sessions))
  const unimported = await unimportedLegacySessions(journalDir)
  if (unimported.length > 0) {
    io.stderr.write(
      `${unimported.length} legacy *.jsonl session file(s) are not imported; ` +
        'run `mcpcut migrate` to see them.\n',
    )
  }
  return 0
}

/**
 * Best-effort: a directory that cannot be probed (permission error, a path
 * component that is not a directory, …) degrades to "nothing to hint about"
 * rather than failing a command whose real output already succeeded.
 */
async function unimportedLegacySessions(journalDir: string | undefined): Promise<readonly string[]> {
  try {
    return await listUnimportedLegacySessions(journalDir ?? JOURNAL_DIR)
  } catch {
    return []
  }
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
    io.stderr.write(`Missing <sessionId> in show command.\n\n${SHOW_USAGE}`)
    return 1
  }

  const direction = values.direction
  if (direction !== undefined && !isValidJournalDirection(direction)) {
    io.stderr.write(
      `Invalid --direction "${direction}". Allowed values: ${JOURNAL_DIRECTIONS.join(', ')}\n\n${SHOW_USAGE}`,
    )
    return 1
  }

  const kind = values.kind
  if (kind !== undefined && !isValidJournalKind(kind)) {
    io.stderr.write(`Invalid --kind "${kind}". Allowed values: ${JOURNAL_KINDS.join(', ')}\n\n${SHOW_USAGE}`)
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
  const unimported = await unimportedLegacySessions(journalDir)
  if (unimported.includes(sessionId)) {
    io.stderr.write(
      `${sessionId} has an un-imported legacy *.jsonl file; run \`mcpcut migrate\` to see it.\n`,
    )
  }
  return 0
}
