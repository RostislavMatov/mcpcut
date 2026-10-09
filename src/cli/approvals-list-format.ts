import { formatReadableField } from '../journal/format.js'
import type { PendingApproval } from '../policy/approvals/queue.js'

/**
 * The readable view of `approvals list`, moved out of `approvals-cmd.ts` when
 * the next-step hints (2026-09-29) took that file to its size limit. Same
 * text, same tests (`tests/cli/approvals-cmd.test.ts` drives it through
 * `runApprovals`).
 */

const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60

/** Readable-mode counterpart of the JSON `truncated`/`totalPending` fields; phrasing matches `ui/pages/approvals.ts`. */
export function formatTruncationNote(shown: number, totalPending: number): string {
  return `${shown} of ${totalPending} pending (showing the oldest)\n`
}

export function formatListReadable(entries: readonly PendingApproval[], nowMs: number): string {
  return entries.map((entry) => formatListLine(entry, nowMs)).join('')
}

/** What follows the id on every row: two spaces, then the server column. */
const ROW_AFTER_ID = '  server='
const LIST_ROW_PATTERN = new RegExp(`^([A-Za-z0-9_-]{1,64})${ROW_AFTER_ID}`)

/**
 * The request id a readable row starts with, or `undefined` for any other line
 * (the truncation note). The console reads its rows back with this (Approvals
 * ▸ list, owner decision 2026-10-01). Safe to trust for that: every field is
 * `formatReadableField`'d, so an agent's newline is a `?` and a row is always
 * exactly one line that begins with its own id. The id shape is the queue's
 * own (`APPROVAL_ID_PATTERN`).
 */
export function approvalIdOfListLine(line: string): string | undefined {
  return LIST_ROW_PATTERN.exec(line)?.[1]
}

/** Every field printed here comes from a queue file on disk -- untrusted, like a journal record. */
function formatListLine(entry: PendingApproval, nowMs: number): string {
  const approvalId = formatReadableField(entry.approvalId)
  const serverName = formatReadableField(entry.serverName)
  const toolName = formatReadableField(entry.toolName)
  const argsPreview = formatArgsPreview(entry.argsRedacted)
  return (
    `${approvalId}${ROW_AFTER_ID}${serverName} tool=${toolName} class=${entry.toolClass} ` +
    `${formatAgent(entry)}waiting=${formatWaiting(entry, nowMs)} ` +
    `agent_connected=${formatConnected(entry)} args=${argsPreview}\n`
  )
}

/** Longest args preview, in characters, before the ellipsis; the full redacted arguments stay in `--json`. */
const ARGS_PREVIEW_MAX_CHARS = 120
const ELLIPSIS = '…'

function formatArgsPreview(argsRedacted: unknown): string {
  const json = formatReadableField(JSON.stringify(argsRedacted))
  return json.length > ARGS_PREVIEW_MAX_CHARS ? `${json.slice(0, ARGS_PREVIEW_MAX_CHARS)}${ELLIPSIS}` : json
}

/** `agent=<name> ` when the entry knows who asked (connect/serve), nothing on the wrap path. One token: no whitespace. */
function formatAgent(entry: PendingApproval): string {
  if (entry.agentName === undefined) return ''
  return `agent=${formatReadableField(entry.agentName).replace(/\s+/g, '_')} `
}

/**
 * How long the request has been waiting (decision M36). The call is held for
 * as long as its agent waits, so the operator's question is no longer "how
 * long do I have" (the two clocks this row printed before) but "how long has
 * it been asking"; the request closes by itself when the agent leaves.
 */
function formatWaiting(entry: PendingApproval, nowMs: number): string {
  const requestedMs = Date.parse(entry.requestedAt)
  return formatDuration(Number.isNaN(requestedMs) ? 0 : Math.max(0, nowMs - requestedMs))
}

/**
 * Whether the process holding the call is still there (its heartbeat, M36).
 * `unknown` for a request an older build enqueued, which has no heartbeat:
 * "we cannot tell" and "gone" are different facts.
 */
function formatConnected(entry: PendingApproval): string {
  if (entry.agentConnected === undefined) return 'unknown'
  if (entry.agentConnected) return 'yes'
  // Since when its process has been silent: an approval now sends nothing (M36, S-L2).
  return entry.holderSeenAt !== undefined ? `no silent_since=${formatReadableField(entry.holderSeenAt)}` : 'no'
}

/** `Nm Ns` (or bare seconds under a minute). */
function formatDuration(remainingMs: number): string {
  const totalSeconds = Math.floor(remainingMs / MS_PER_SECOND)
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
  const seconds = totalSeconds % SECONDS_PER_MINUTE
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`
}
