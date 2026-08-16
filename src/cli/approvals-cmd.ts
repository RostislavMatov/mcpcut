import { parseArgs } from 'node:util'
import { APPROVALS_LIST_MAX_ROWS } from '../config.js'
import { formatReadableField } from '../journal/format.js'
import {
  createApprovalQueue,
  type ApprovalQueue,
  type PendingApproval,
  type ResolveOutcome,
} from '../policy/approvals/queue.js'
import { DEFAULT_GRANT_TTL_MS } from '../policy/constants.js'

/**
 * `approvals list|approve|deny`: the operator-facing half of the approvals
 * queue (`policy/approvals/queue.ts`). Kept as a plain function rather than a
 * `main()` so `src/cli.ts` can dispatch into it and tests can drive it
 * without touching the real `process.stdout`/`process.stderr`.
 */

/** Minimal shape this command needs from stdout/stderr; satisfied by `process.stdout` and test doubles alike. */
export interface CliWritable {
  write(chunk: string): unknown
}

export interface ApprovalsCliIo {
  readonly stdout: CliWritable
  readonly stderr: CliWritable
}

export interface ApprovalsCliOptions {
  /** Root directory for the approvals queue. Defaults to `JOURNAL_DIR/approvals` (see `queue.ts`). */
  readonly baseDir?: string
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  readonly clock?: () => number
  /**
   * Injectable queue, for tests exercising the bounded-read truncation path
   * (`list()` capped at `APPROVALS_LIST_MAX_ROWS`) without seeding hundreds
   * of real rows through the on-disk queue. Defaults to a queue built from
   * `baseDir`/`clock`.
   */
  readonly queue?: ApprovalQueue
}

const USAGE = `Usage:
  approvals list [--json]                  List pending approval requests
  approvals approve <id> [--reason TEXT]   Approve a pending request
  approvals deny <id> [--reason TEXT]      Deny a pending request
`

const MS_PER_MINUTE = 60_000
const MS_PER_SECOND = 1000
/** Actor recorded on every resolution made through this CLI, distinct from an eventual admin-UI actor. */
const CLI_ACTOR = 'cli'

/** The operator sees an already-resolved-or-unknown id the same way in both subcommands. */
const NOT_FOUND_MESSAGE = 'No pending approval with that id (already resolved or unknown id).'

export async function runApprovals(
  args: string[],
  io: ApprovalsCliIo = { stdout: process.stdout, stderr: process.stderr },
  opts: ApprovalsCliOptions = {},
): Promise<number> {
  const subcommand = args[0]
  const queue =
    opts.queue ??
    createApprovalQueue({
      ...(opts.baseDir !== undefined ? { baseDir: opts.baseDir } : {}),
      ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    })
  const clock = opts.clock ?? Date.now

  if (subcommand === 'list') {
    return runList(queue, args.slice(1), io, clock)
  }
  if (subcommand === 'approve') {
    return runResolve(queue, args.slice(1), io, 'approved')
  }
  if (subcommand === 'deny') {
    return runResolve(queue, args.slice(1), io, 'denied')
  }

  io.stderr.write(`Unknown approvals subcommand: ${subcommand ?? '(none)'}\n\n${USAGE}`)
  return 1
}

async function runList(
  queue: ApprovalQueue,
  listArgs: readonly string[],
  io: ApprovalsCliIo,
  clock: () => number,
): Promise<number> {
  let json: boolean
  try {
    const parsed = parseArgs({
      args: [...listArgs],
      options: { json: { type: 'boolean', default: false } },
      allowPositionals: true,
    })
    json = parsed.values.json === true
  } catch {
    io.stderr.write(USAGE)
    return 1
  }

  const entries = await queue.list()
  // `list()` is bounded (APPROVALS_LIST_MAX_ROWS); pair it with `countPending()`
  // so a queue larger than the bound doesn't read as "the whole queue" to
  // either a human or a script (code-review finding 4). Mirrors
  // `ui/handlers/approvals.ts`'s aggregation of the same two calls.
  const totalPending = await queue.countPending()
  // Truncation is a property of THIS read hitting its own bound, not of a
  // comparison between two reads. The two calls are separate transactions, so
  // a request committing between them made `totalPending > entries.length`
  // true on a queue of one — reporting truncation that never happened.
  const truncated = entries.length >= APPROVALS_LIST_MAX_ROWS && totalPending > entries.length

  if (json) {
    // ONE shape, always. Emitting a bare array when untruncated and an object
    // otherwise made the contract depend on runtime state: a script parsing it
    // worked until the queue grew, then broke — and, via the race above, broke
    // non-deterministically on a queue of one.
    io.stdout.write(`${JSON.stringify({ truncated, totalPending, approvals: entries })}\n`)
    return 0
  }

  if (entries.length === 0) {
    io.stdout.write('no pending approvals\n')
    return 0
  }

  const truncationNote = truncated ? formatTruncationNote(entries.length, totalPending) : ''
  io.stdout.write(truncationNote + formatListReadable(entries, clock()))
  return 0
}

/** Readable-mode counterpart of the JSON `truncated`/`totalPending` fields; phrasing matches `ui/pages/approvals.ts`. */
function formatTruncationNote(shown: number, totalPending: number): string {
  return `${shown} of ${totalPending} pending (showing the oldest)\n`
}

function formatListReadable(entries: readonly PendingApproval[], nowMs: number): string {
  return entries.map((entry) => formatListLine(entry, nowMs)).join('')
}

/** Every field printed here comes from a queue file on disk -- untrusted, like a journal record. */
function formatListLine(entry: PendingApproval, nowMs: number): string {
  const approvalId = formatReadableField(entry.approvalId)
  const serverName = formatReadableField(entry.serverName)
  const toolName = formatReadableField(entry.toolName)
  const argsPreview = formatReadableField(JSON.stringify(entry.argsRedacted))
  const remaining = formatTimeRemaining(entry, nowMs)
  return `${approvalId}  server=${serverName} tool=${toolName} class=${entry.toolClass} expires_in=${remaining} args=${argsPreview}\n`
}

/** `entry.expired` is derived by `queue.list()` from the same clock, so the two never disagree. */
function formatTimeRemaining(entry: PendingApproval, nowMs: number): string {
  if (entry.expired) return 'expired'

  const remainingMs = Math.max(0, Date.parse(entry.expiresAt) - nowMs)
  const totalSeconds = Math.floor(remainingMs / MS_PER_SECOND)
  const minutes = Math.floor(totalSeconds / (MS_PER_MINUTE / MS_PER_SECOND))
  const seconds = totalSeconds % (MS_PER_MINUTE / MS_PER_SECOND)
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`
}

/** Shared body of `approve <id>` and `deny <id>`: parse, resolve, report. */
async function runResolve(
  queue: ApprovalQueue,
  resolveArgs: readonly string[],
  io: ApprovalsCliIo,
  outcome: ResolveOutcome,
): Promise<number> {
  let approvalId: string | undefined
  let reason: string | undefined
  try {
    const parsed = parseArgs({
      args: [...resolveArgs],
      options: { reason: { type: 'string' } },
      allowPositionals: true,
    })
    approvalId = parsed.positionals[0]
    reason = parsed.values.reason
  } catch {
    io.stderr.write(USAGE)
    return 1
  }

  if (approvalId === undefined) {
    io.stderr.write(`Missing <id> in approvals ${outcome === 'approved' ? 'approve' : 'deny'} command.\n\n${USAGE}`)
    return 1
  }

  const result = await queue.resolve(approvalId, {
    outcome,
    actor: CLI_ACTOR,
    ...(reason !== undefined ? { reason } : {}),
  })

  if (!result.ok) {
    io.stderr.write(`${NOT_FOUND_MESSAGE}\n`)
    return 1
  }

  const safeId = formatReadableField(approvalId)
  io.stdout.write(outcome === 'approved' ? approvedMessage(safeId) : `Denied ${safeId}.\n`)
  return 0
}

function approvedMessage(safeId: string): string {
  const grantMinutes = Math.round(DEFAULT_GRANT_TTL_MS / MS_PER_MINUTE)
  return (
    `Approved ${safeId}. The agent's retry within ${grantMinutes} minute(s) of this approval ` +
    `(default grant TTL; the active policy may override it) will pass without a second approval.\n`
  )
}
