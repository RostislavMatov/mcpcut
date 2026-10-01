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

/**
 * What the wait column says when the queue entry carries no `waitExpiresAt`
 * at all (a request enqueued before M4, or by a caller that declared no wait).
 * Named rather than blank: "we do not know" and "the agent left" are different
 * facts, and only one of them means an approval still delivers the call.
 */
const AGENT_WAIT_UNKNOWN = 'agent_wait=unknown'

/**
 * What the wait column says once the agent's own window has closed. The words
 * are the point: the entry is still listed and still approvable, but the call
 * it belonged to is gone, so approving now only mints a grant the agent has to
 * come back and use (the M2 dogfood tail, and the reason the web card carries
 * the same sentence).
 */
const AGENT_WAIT_OVER = 'agent_wait=over(retry_passes_after_approve)'

/** Every field printed here comes from a queue file on disk -- untrusted, like a journal record. */
function formatListLine(entry: PendingApproval, nowMs: number): string {
  const approvalId = formatReadableField(entry.approvalId)
  const serverName = formatReadableField(entry.serverName)
  const toolName = formatReadableField(entry.toolName)
  const argsPreview = formatArgsPreview(entry.argsRedacted)
  const remaining = formatTimeRemaining(entry, nowMs)
  const waiting = formatAgentWait(entry, nowMs)
  return (
    `${approvalId}  server=${serverName} tool=${toolName} class=${entry.toolClass} ` +
    `${formatAgent(entry)}${waiting} expires_in=${remaining} args=${argsPreview}\n`
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
 * The AGENT's remaining wait, which is not the grant window: the queue entry
 * expires in minutes, while the call blocking on it gives up in seconds
 * (`approval.waitTimeoutMs`). Printing only the grant window told an operator
 * they had four minutes to decide when they had forty seconds (user-journey
 * smoke UX-8). `waitExpiresAt` has been on the record since M4 and in
 * `--json`; this is the same fact in the view a human reads.
 */
function formatAgentWait(entry: PendingApproval, nowMs: number): string {
  const waitExpiresAt = entry.waitExpiresAt
  if (waitExpiresAt === undefined) return AGENT_WAIT_UNKNOWN
  const deadlineMs = Date.parse(waitExpiresAt)
  if (Number.isNaN(deadlineMs)) return AGENT_WAIT_UNKNOWN
  const remainingMs = deadlineMs - nowMs
  return remainingMs > 0 ? `agent_wait_left=${formatDuration(remainingMs)}` : AGENT_WAIT_OVER
}

/** `entry.expired` is derived by `queue.list()` from the same clock, so the two never disagree. */
function formatTimeRemaining(entry: PendingApproval, nowMs: number): string {
  if (entry.expired) return 'expired'

  return formatDuration(Math.max(0, Date.parse(entry.expiresAt) - nowMs))
}

/** `Nm Ns` (or bare seconds under a minute) — the shape both clocks are printed in. */
function formatDuration(remainingMs: number): string {
  const totalSeconds = Math.floor(remainingMs / MS_PER_SECOND)
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
  const seconds = totalSeconds % SECONDS_PER_MINUTE
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`
}
