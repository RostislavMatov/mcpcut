import { parseArgs } from 'node:util'
import { APPROVAL_RESOLVE_MIN_ROLE, roleSatisfies } from '../admin/authz.js'
import { ADMIN_TOKEN_ENV_VAR } from '../admin/constants.js'
import { createAdminStore } from '../admin/store.js'
import { APPROVALS_LIST_MAX_ROWS } from '../config.js'
import { formatReadableField } from '../journal/format.js'
import {
  createApprovalQueue,
  type ApprovalQueue,
  type PendingApproval,
  type ResolveOutcome,
} from '../policy/approvals/queue.js'
import { DEFAULT_GRANT_TTL_MS } from '../policy/constants.js'
import { isExpectedAdminError } from './admin-cmd.js'

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
  /**
   * Journal directory holding the admin store that resolves `MCP_ADMIN_TOKEN`
   * to a named human. Defaults to `JOURNAL_DIR` (see `admin/store.ts`).
   */
  readonly journalDir?: string
  /**
   * Environment: the source of `MCP_ADMIN_TOKEN`. Injectable rather than read
   * from `process.env` inside the command, following the `connect` seam, so a
   * test never depends on the developer's own exported token.
   */
  readonly env?: NodeJS.ProcessEnv
}

const USAGE = `Usage:
  approvals list [--json]                  List pending approval requests
  approvals approve <id> [--reason TEXT]   Approve a pending request (needs ${ADMIN_TOKEN_ENV_VAR})
  approvals deny <id> [--reason TEXT]      Deny a pending request (needs ${ADMIN_TOKEN_ENV_VAR})

${ADMIN_TOKEN_ENV_VAR} is your personal admin token ("mcpcut admin add").
It records WHICH admin resolved a request; listing needs no token.
`

const MS_PER_MINUTE = 60_000
const MS_PER_SECOND = 1000
/** Prefix of the `actor` recorded by this CLI, mirroring the UI's `ui:<adminName>`. */
const CLI_ACTOR_PREFIX = 'cli:'

/**
 * No token at all. Says what to do without echoing anything that was supplied
 * (there was nothing) and without claiming the token is a barrier: it names
 * the human, it does not keep anyone out.
 */
const MISSING_TOKEN_MESSAGE =
  `Refusing to resolve: no admin token. Set ${ADMIN_TOKEN_ENV_VAR} to your personal admin token so ` +
  `the resolution records which admin decided it.\n` +
  `Get one with: mcpcut admin add <name> --role operator   (existing admin: mcpcut admin rotate <name>)\n`

/**
 * A token was supplied and matched no ACTIVE admin. Deliberately says nothing
 * about the value: no length, no prefix, and no distinction between "malformed"
 * and "well-formed but unknown" — the command never inspects the shape, so a
 * caller cannot learn from the message whether a guess was even the right
 * form. Revoked and never-existed collapse into this one message on purpose
 * (`findAdminByToken` cannot tell them apart either).
 */
const UNKNOWN_TOKEN_MESSAGE =
  `Refusing to resolve: ${ADMIN_TOKEN_ENV_VAR} does not match any active admin — it may have been ` +
  `rotated, or the admin removed.\n` +
  `Check "mcpcut admin list", then: mcpcut admin rotate <name>\n`

/**
 * A real, active admin whose role is below the resolve threshold. Names the
 * requirement and nothing else about the account — no name, no current role,
 * nothing derived from the token.
 */
const INSUFFICIENT_ROLE_MESSAGE =
  `Refusing to resolve: this admin token's role may not resolve approvals ` +
  `(role "${APPROVAL_RESOLVE_MIN_ROLE}" or higher is required, the same rule the admin UI applies).\n` +
  `An owner can change it with: mcpcut admin role <name> ${APPROVAL_RESOLVE_MIN_ROLE}\n`

/**
 * The admin store could not be read at all, so no token can be resolved to a
 * human. Names the failure (the store error text is operator-facing: a path
 * and a parse/lock reason) and routes it through `formatReadableField` like
 * every other string this CLI prints from disk.
 */
function storeUnreadableMessage(detail: string): string {
  return (
    `Refusing to resolve: the admin store could not be read, so this resolution could not be ` +
    `attributed to a human.\n${formatReadableField(detail)}\n` +
    `Check the file named above, then: mcpcut admin list\n`
  )
}

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
    // Deliberately token-free: reading the queue is not an authorization event.
    return runList(queue, args.slice(1), io, clock)
  }
  if (subcommand === 'approve' || subcommand === 'deny') {
    // Authorize BEFORE anything can be written. A run that cannot name the
    // human must change nothing at all -- resolving first and failing to
    // attribute afterwards would leave an anonymous record in the chain.
    const actor = await resolveCliActor(io, opts)
    if (actor === undefined) return 1
    const outcome: ResolveOutcome = subcommand === 'approve' ? 'approved' : 'denied'
    return runResolve(queue, args.slice(1), io, outcome, actor)
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

/**
 * What the wait column says when the queue entry carries no `waitExpiresAt`
 * at all (a request enqueued before M4, or by a caller that declared no wait).
 * Named rather than blank: "we do not know" and "the agent left" are different
 * facts, and only one of them means an approval still delivers the call.
 */
const AGENT_WAIT_UNKNOWN = 'unknown'

/**
 * What the wait column says once the agent's own window has closed. The words
 * are the point: the entry is still listed and still approvable, but the call
 * it belonged to is gone, so approving now only mints a grant the agent has to
 * come back and use (the M2 dogfood tail, and the reason the web card carries
 * the same sentence).
 */
const AGENT_WAIT_ELAPSED = 'elapsed(retry-only)'

/** Every field printed here comes from a queue file on disk -- untrusted, like a journal record. */
function formatListLine(entry: PendingApproval, nowMs: number): string {
  const approvalId = formatReadableField(entry.approvalId)
  const serverName = formatReadableField(entry.serverName)
  const toolName = formatReadableField(entry.toolName)
  const argsPreview = formatReadableField(JSON.stringify(entry.argsRedacted))
  const remaining = formatTimeRemaining(entry, nowMs)
  const waiting = formatAgentWait(entry, nowMs)
  return (
    `${approvalId}  server=${serverName} tool=${toolName} class=${entry.toolClass} ` +
    `agent_waits=${waiting} expires_in=${remaining} args=${argsPreview}\n`
  )
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
  return remainingMs > 0 ? formatDuration(remainingMs) : AGENT_WAIT_ELAPSED
}

/** `entry.expired` is derived by `queue.list()` from the same clock, so the two never disagree. */
function formatTimeRemaining(entry: PendingApproval, nowMs: number): string {
  if (entry.expired) return 'expired'

  return formatDuration(Math.max(0, Date.parse(entry.expiresAt) - nowMs))
}

/** `Nm Ns` (or bare seconds under a minute) — the shape both clocks are printed in. */
function formatDuration(remainingMs: number): string {
  const totalSeconds = Math.floor(remainingMs / MS_PER_SECOND)
  const minutes = Math.floor(totalSeconds / (MS_PER_MINUTE / MS_PER_SECOND))
  const seconds = totalSeconds % (MS_PER_MINUTE / MS_PER_SECOND)
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`
}

/**
 * The `actor` for a resolution made from this shell: `cli:<adminName>` for the
 * named admin behind `MCP_ADMIN_TOKEN`, or `undefined` (with a diagnostic
 * already written) when no resolution may happen.
 *
 * This buys ATTRIBUTION, not an access barrier — a process under the same uid
 * can read the environment anyway (ADR-0004, "what we do not defend against").
 * What it does buy is that the record names a human, and that the CLI cannot
 * be used to step around the role the admin UI enforces on the same action.
 */
async function resolveCliActor(
  io: ApprovalsCliIo,
  opts: ApprovalsCliOptions,
): Promise<string | undefined> {
  const env = opts.env ?? process.env
  const token = env[ADMIN_TOKEN_ENV_VAR]
  if (token === undefined || token === '') {
    io.stderr.write(MISSING_TOKEN_MESSAGE)
    return undefined
  }

  const store = createAdminStore(
    opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {},
  )
  // The one comparison path: constant-work hash matching, revoked admins
  // resolving exactly like a token that never existed (`admin/store.ts`).
  //
  // A store that cannot be READ (hand-edited or truncated `admins.json`, a
  // locked or corrupt state db) is a refusal, not a crash: the operator gets
  // the same exit-1 diagnostic as the three token failures above. Fail closed
  // — returning `undefined` here means nothing is resolved, so an unreadable
  // admin store can never produce an unattributed resolution.
  let admin: Awaited<ReturnType<typeof store.findAdminByToken>>
  try {
    admin = await store.findAdminByToken(token)
  } catch (error: unknown) {
    if (!isExpectedAdminError(error)) throw error
    io.stderr.write(storeUnreadableMessage(error.message))
    return undefined
  }
  if (admin === undefined) {
    io.stderr.write(UNKNOWN_TOKEN_MESSAGE)
    return undefined
  }
  if (!roleSatisfies(admin.role, APPROVAL_RESOLVE_MIN_ROLE)) {
    io.stderr.write(INSUFFICIENT_ROLE_MESSAGE)
    return undefined
  }

  // `admin.name` is schema-validated against ADMIN_NAME_PATTERN on read, so it
  // is safe to compose into a stored field without further escaping.
  return `${CLI_ACTOR_PREFIX}${admin.name}`
}

/** Shared body of `approve <id>` and `deny <id>`: parse, resolve, report. */
async function runResolve(
  queue: ApprovalQueue,
  resolveArgs: readonly string[],
  io: ApprovalsCliIo,
  outcome: ResolveOutcome,
  actor: string,
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
    actor,
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
