#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { listSessions, readSessionWithStats, type SessionSummary } from './journal/reader.js'
import type { JournalDirection, JournalRecord } from './journal/record.js'
import { runWrap } from './proxy/wrap.js'

/**
 * Thin argv-dispatch entry point. All real logic lives in tested modules
 * (proxy/wrap.ts, journal/reader.ts) — this file only parses argv, calls
 * them, and formats output. Excluded from coverage by design.
 */

const USAGE = `Usage:
  mcp-journal wrap -- <cmd> [args...]   Run a wrapped MCP server, journaling all traffic
  mcp-journal sessions                  List journaled sessions
  mcp-journal show <sessionId> [--method X] [--direction Y] [--json]
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
  const childCommand = dashIndex === -1 ? undefined : wrapArgs[dashIndex + 1]
  if (dashIndex === -1 || childCommand === undefined) {
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

/** Parses `show <sessionId> [--method X] [--direction Y] [--json]` and prints its records. */
async function runShowCommand(showArgs: readonly string[]): Promise<number> {
  const sessionId = showArgs[0]
  if (sessionId === undefined) {
    process.stderr.write(`Missing <sessionId> in show command.\n\n${USAGE}`)
    return 1
  }

  const { values } = parseArgs({
    args: [...showArgs.slice(1)],
    options: {
      method: { type: 'string' },
      direction: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  })

  const { records, skippedLineCount } = await readSessionWithStats(sessionId, {
    ...(values.method !== undefined ? { method: values.method } : {}),
    ...(values.direction !== undefined ? { direction: values.direction as JournalDirection } : {}),
  })

  process.stdout.write(values.json === true ? formatRecordsJson(records) : formatRecordsReadable(records))
  if (skippedLineCount > 0) {
    process.stderr.write(`Skipped ${skippedLineCount} unreadable journal line(s).\n`)
  }
  return 0
}

function formatSessionsTable(sessions: readonly SessionSummary[]): string {
  const header = `${'sessionId'.padEnd(28)}  ${'firstTs'.padEnd(24)}  ${'lastTs'.padEnd(24)}  messages\n`
  const rows = sessions
    .map(
      (session) =>
        `${session.sessionId.padEnd(28)}  ${session.firstTs.padEnd(24)}  ${session.lastTs.padEnd(24)}  ${session.messageCount}\n`,
    )
    .join('')
  return header + rows
}

function formatRecordsJson(records: readonly JournalRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : '')
}

function formatRecordsReadable(records: readonly JournalRecord[]): string {
  return records.map(formatRecordLine).join('')
}

function formatRecordLine(record: JournalRecord): string {
  const method = record.method ?? '-'
  const payload = truncate(JSON.stringify(record.payload), PAYLOAD_TRUNCATE_LENGTH)
  return `${record.ts}  ${record.direction.padEnd(14)}  ${record.kind.padEnd(12)}  ${method.padEnd(16)}  ${payload}\n`
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
