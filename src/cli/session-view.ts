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
const TOOL_NAMES_TRUNCATE_LENGTH = 120
/** The tool name a catalog decision (`tools/list`) is recorded under. */
const TOOLS_LIST_TOOL = 'tools/list'

const UNKNOWN_COLUMN = '-'
const MESSAGES_COLUMN_WIDTH = 8

export function formatSessionsTable(sessions: readonly SessionSummary[]): string {
  const serverWidth = Math.max('server'.length, ...sessions.map((s) => serverOf(s).length))
  const header =
    `${'sessionId'.padEnd(28)}  ${'firstTs'.padEnd(24)}  ${'lastTs'.padEnd(24)}  ` +
    `${'messages'.padEnd(MESSAGES_COLUMN_WIDTH)}  ${'server'.padEnd(serverWidth)}  agent\n`
  const rows = sessions.map((session) => formatSessionLine(session, serverWidth)).join('')
  return header + rows
}

function serverOf(session: SessionSummary): string {
  return formatReadableField(session.serverName ?? UNKNOWN_COLUMN)
}

function formatSessionLine(session: SessionSummary, serverWidth: number): string {
  const sessionId = formatReadableField(session.sessionId)
  const firstTs = formatReadableField(session.firstTs)
  const lastTs = formatReadableField(session.lastTs)
  const messages = String(session.messageCount).padEnd(MESSAGES_COLUMN_WIDTH)
  const agent = formatReadableField(session.agentName ?? UNKNOWN_COLUMN)
  return (
    `${sessionId.padEnd(28)}  ${firstTs.padEnd(24)}  ${lastTs.padEnd(24)}  ${messages}  ` +
    `${serverOf(session).padEnd(serverWidth)}  ${agent}\n`
  )
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
  const head = `${ts}  ${direction.padEnd(14)}  ${kind.padEnd(12)}  ${method.padEnd(16)}  `
  return `${head}${record.decision === undefined ? payloadText(record.payload) : decisionText(record)}\n`
}

/** A decision row leads with the verdict, then what the call carried: the arguments, or a tool count for a catalog. */
function decisionText(record: JournalRecord): string {
  const summary = formatDecisionSummary(record.decision as NonNullable<JournalRecord['decision']>)
  const detail = record.decision?.toolName === TOOLS_LIST_TOOL ? toolCountText(record.payload) : undefined
  // A record with no arguments of its own (M36 phase C, a revocation) shows none, not `null`.
  const tail = detail ?? (record.payload === null ? '' : payloadText(record.payload))
  return tail === '' ? summary : `${summary}  ${tail}`
}

function toolCountText(payload: unknown): string | undefined {
  const tools = (payload as { readonly tools?: unknown } | null | undefined)?.tools
  if (!Array.isArray(tools)) return undefined
  const names = truncate(tools.map((tool) => formatReadableField(String(tool))).join(', '), TOOL_NAMES_TRUNCATE_LENGTH)
  return `${tools.length} tool${tools.length === 1 ? '' : 's'}: ${names}`
}

function payloadText(payload: unknown): string {
  const json = JSON.stringify(payload)
  return json === undefined ? '' : truncate(json, PAYLOAD_TRUNCATE_LENGTH)
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}
