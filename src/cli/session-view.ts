import { formatDecisionSummary, formatReadableField } from '../journal/format.js'
import type { SessionSummary } from '../journal/reader.js'
import type { JournalRecord } from '../journal/record.js'

/**
 * Output formatting for `sessions` and `show`, split out of `cli.ts` so the
 * dispatcher stays argument-marshaling only. Every field formatted here
 * comes from a journal file on disk, which is untrusted (hand-edited,
 * truncated mid-write, or attacker-influenced payload content) -- see
 * `journal/format.ts`'s `formatReadableField`.
 */

const PAYLOAD_TRUNCATE_LENGTH = 200

export function formatSessionsTable(sessions: readonly SessionSummary[]): string {
  const header = `${'sessionId'.padEnd(28)}  ${'firstTs'.padEnd(24)}  ${'lastTs'.padEnd(24)}  messages\n`
  const rows = sessions.map(formatSessionLine).join('')
  return header + rows
}

function formatSessionLine(session: SessionSummary): string {
  const sessionId = formatReadableField(session.sessionId)
  const firstTs = formatReadableField(session.firstTs)
  const lastTs = formatReadableField(session.lastTs)
  return `${sessionId.padEnd(28)}  ${firstTs.padEnd(24)}  ${lastTs.padEnd(24)}  ${session.messageCount}\n`
}

export function formatRecordsJson(records: readonly JournalRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : '')
}

export function formatRecordsReadable(records: readonly JournalRecord[]): string {
  return records.map(formatRecordLine).join('')
}

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
