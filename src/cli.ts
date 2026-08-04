#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { formatDecisionSummary, formatReadableField } from './journal/format.js'
import {
  isValidJournalDirection,
  isValidJournalKind,
  JOURNAL_DIRECTIONS,
  JOURNAL_KINDS,
  listSessions,
  readSessionWithStats,
  type SessionSummary,
} from './journal/reader.js'
import type { JournalRecord } from './journal/record.js'
import { runWrap } from './proxy/wrap.js'

/**
 * Thin argv-dispatch entry point. All real logic lives in tested modules
 * (proxy/wrap.ts, journal/reader.ts) — this file only parses argv, calls
 * them, and formats output. Excluded from coverage by design.
 */

const USAGE = `Usage:
  mcp-journal wrap -- <cmd> [args...]   Run a wrapped MCP server, journaling all traffic
  mcp-journal sessions                  List journaled sessions
  mcp-journal show <sessionId> [--method X] [--direction Y] [--kind Z] [--json]
                                         Print one session's journal records
  mcp-journal --help                    Show this message
`

const PAYLOAD_TRUNCATE_LENGTH = 200

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const command = argv[0]

  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return 0
  }
  if (command === 'wrap') {
    return runWrapCommand(argv.slice(1))
  }
  if (command === 'sessions') {
    return runSessionsCommand()
  }
  if (command === 'show') {
    return runShowCommand(argv.slice(1))
  }

  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`)
  return 1
}

/** Splits `wrap -- <cmd> [args...]` and runs the wrapped server to completion. */
async function runWrapCommand(wrapArgs: readonly string[]): Promise<number> {
  const dashIndex = wrapArgs.indexOf('--')
  if (dashIndex === -1) {
    process.stderr.write(`Missing "-- <cmd>" in wrap command.\n\n${USAGE}`)
    return 1
  }
  if (dashIndex > 0) {
    process.stderr.write(
      `Unknown option(s) before "--" in wrap command: ${wrapArgs.slice(0, dashIndex).join(' ')}\n\n${USAGE}`,
    )
    return 1
  }

  const childCommand = wrapArgs[dashIndex + 1]
  if (childCommand === undefined) {
    process.stderr.write(`Missing "-- <cmd>" in wrap command.\n\n${USAGE}`)
    return 1
  }

  const childArgs = wrapArgs.slice(dashIndex + 2)
  return runWrap(childCommand, childArgs)
}

async function runSessionsCommand(): Promise<number> {
  const sessions = await listSessions()
  process.stdout.write(sessions.length === 0 ? 'No sessions found.\n' : formatSessionsTable(sessions))
  return 0
}

/**
 * Parses `show <sessionId> [--method X] [--direction Y] [--json]` and prints
 * its records. Options are parsed from the *whole* argument list before the
 * positional sessionId is read, so `show --json 01ABC` cannot silently treat
 * `--json` as the session id.
 */
async function runShowCommand(showArgs: readonly string[]): Promise<number> {
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
    process.stderr.write(`Missing <sessionId> in show command.\n\n${USAGE}`)
    return 1
  }

  const direction = values.direction
  if (direction !== undefined && !isValidJournalDirection(direction)) {
    process.stderr.write(
      `Invalid --direction "${direction}". Allowed values: ${JOURNAL_DIRECTIONS.join(', ')}\n\n${USAGE}`,
    )
    return 1
  }

  const kind = values.kind
  if (kind !== undefined && !isValidJournalKind(kind)) {
    process.stderr.write(`Invalid --kind "${kind}". Allowed values: ${JOURNAL_KINDS.join(', ')}\n\n${USAGE}`)
    return 1
  }

  const { records, skippedLineCount } = await readSessionWithStats(sessionId, {
    ...(values.method !== undefined ? { method: values.method } : {}),
    ...(direction !== undefined ? { direction } : {}),
    ...(kind !== undefined ? { kind } : {}),
  })

  process.stdout.write(values.json === true ? formatRecordsJson(records) : formatRecordsReadable(records))
  if (skippedLineCount > 0) {
    process.stderr.write(`Skipped ${skippedLineCount} unreadable journal line(s).\n`)
  }
  return 0
}

function formatSessionsTable(sessions: readonly SessionSummary[]): string {
  const header = `${'sessionId'.padEnd(28)}  ${'firstTs'.padEnd(24)}  ${'lastTs'.padEnd(24)}  messages\n`
  const rows = sessions.map(formatSessionLine).join('')
  return header + rows
}

/** Session summaries come from journal files on disk, which are untrusted. */
function formatSessionLine(session: SessionSummary): string {
  const sessionId = formatReadableField(session.sessionId)
  const firstTs = formatReadableField(session.firstTs)
  const lastTs = formatReadableField(session.lastTs)
  return `${sessionId.padEnd(28)}  ${firstTs.padEnd(24)}  ${lastTs.padEnd(24)}  ${session.messageCount}\n`
}

function formatRecordsJson(records: readonly JournalRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : '')
}

function formatRecordsReadable(records: readonly JournalRecord[]): string {
  return records.map(formatRecordLine).join('')
}

/** Record fields come from journal files on disk, which are untrusted (see journal/format.ts). */
function formatRecordLine(record: JournalRecord): string {
  const ts = formatReadableField(record.ts)
  const direction = formatReadableField(record.direction)
  const kind = formatReadableField(record.kind)
  const method = formatReadableField(record.method ?? '-')
  const payload = truncate(JSON.stringify(record.payload), PAYLOAD_TRUNCATE_LENGTH)
  const decision = record.decision === undefined ? '' : `  ${formatDecisionSummary(record.decision)}`
  return `${ts}  ${direction.padEnd(14)}  ${kind.padEnd(12)}  ${method.padEnd(16)}  ${payload}${decision}\n`
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
