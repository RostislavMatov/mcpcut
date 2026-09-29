import { parseArgs } from 'node:util'
import { JOURNAL_DIR } from '../config.js'
import { listUnimportedLegacySessions } from '../journal/import.js'
import { isValidSessionId } from '../journal/session-id.js'
import {
  isValidJournalDirection,
  isValidJournalKind,
  JOURNAL_DIRECTIONS,
  JOURNAL_KINDS,
  listSessions,
  readSessionWithStats,
  type SessionSummary,
} from '../journal/reader.js'
import { recordFirstSessionHint, showSessionHint, unknownSessionMessage } from './next-step.js'
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
    // With nothing imported yet, migrate IS the next step: no second hint.
    io.stderr.write(
      `${unimported.length} legacy *.jsonl session file(s) are not imported; ` +
        'run `mcpcut migrate` to see them.\n',
    )
  }
  if (sessions.length > 0 || unimported.length === 0) io.stderr.write(nextSessionHint(sessions))
  return 0
}

/**
 * The newest session, ready to paste, or how to record the first one. The
 * list is newest-first (`listSessions`), so the latest is its head.
 */
function nextSessionHint(sessions: readonly SessionSummary[]): string {
  const latest = sessions[0]
  return latest === undefined ? recordFirstSessionHint() : showSessionHint(latest.sessionId)
}

/** The same hint on a usage-error path, where a journal that cannot be listed must not turn exit 1 into a crash. */
async function bestEffortSessionHint(journalDir: string | undefined): Promise<string> {
  try {
    return nextSessionHint(await listSessions(journalDir))
  } catch {
    return ''
  }
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
  const { direction, kind, json } = values

  const sessionId = positionals[0]
  if (sessionId === undefined) {
    io.stderr.write(`Missing <sessionId> in show command.\n\n${SHOW_USAGE}`)
    io.stderr.write(await bestEffortSessionHint(journalDir))
    return 1
  }
  const filterError = invalidFilterMessage(direction, kind)
  if (filterError !== undefined) {
    io.stderr.write(`${filterError}\n\n${SHOW_USAGE}`)
    return 1
  }
  if (!isValidSessionId(sessionId)) return refuseUnknownSession(io, sessionId)

  const { records, skippedLineCount } = await readSessionWithStats(sessionId, {
    ...(journalDir !== undefined ? { dir: journalDir } : {}),
    ...(values.method !== undefined ? { method: values.method } : {}),
    ...(direction !== undefined && isValidJournalDirection(direction) ? { direction } : {}),
    ...(kind !== undefined ? { kind } : {}),
  })

  const isLegacyOnly = (await unimportedLegacySessions(journalDir)).includes(sessionId)
  if (records.length === 0 && !isLegacyOnly && !(await sessionExists(sessionId, journalDir))) {
    return refuseUnknownSession(io, sessionId)
  }

  io.stdout.write(json === true ? formatRecordsJson(records) : formatRecordsReadable(records))
  if (skippedLineCount > 0) {
    io.stderr.write(`Skipped ${skippedLineCount} unreadable journal line(s).\n`)
  }
  if (isLegacyOnly) {
    io.stderr.write(
      `${sessionId} has an un-imported legacy *.jsonl file; run \`mcpcut migrate\` to see it.\n`,
    )
  }
  return 0
}

/** Names the first bad filter value and what it may be instead, or `undefined` when both are fine. */
function invalidFilterMessage(direction: string | undefined, kind: string | undefined): string | undefined {
  if (direction !== undefined && !isValidJournalDirection(direction)) {
    return `Invalid --direction "${direction}". Allowed values: ${JOURNAL_DIRECTIONS.join(', ')}`
  }
  if (kind !== undefined && !isValidJournalKind(kind)) {
    return `Invalid --kind "${kind}". Allowed values: ${JOURNAL_KINDS.join(', ')}`
  }
  return undefined
}

/**
 * An id the journal never held (or never could): an error that points back
 * at the list. Stdout stays what it always was for no records — empty, in
 * both views (`--json` is JSONL) — so a script learns it from the exit code.
 */
function refuseUnknownSession(io: JournalCliIo, sessionId: string): number {
  io.stderr.write(unknownSessionMessage(sessionId))
  return 1
}

/**
 * Asked only when a read came back empty: a filter that matched nothing in a
 * real session is an answer, an id the journal never held is an error.
 */
async function sessionExists(sessionId: string, journalDir: string | undefined): Promise<boolean> {
  const sessions = await listSessions(journalDir)
  return sessions.some((session) => session.sessionId === sessionId)
}
