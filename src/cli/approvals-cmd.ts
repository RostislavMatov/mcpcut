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
import type { ResolvedApprovalFile } from '../policy/approvals/queue-file.js'
import { DEFAULT_GRANT_TTL_MS } from '../policy/constants.js'
import { isExpectedAdminError } from './admin-cmd.js'
import { adminStoreEmptiness, NO_ADMINS_YET_ACTOR, noAdminsYetNotice } from './admin-token.js'
import { formatListReadable, formatTruncationNote } from './approvals-list-format.js'
import { listApprovalsHint, noPendingApprovalsHint, resolveApprovalHint } from './next-step.js'

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
It records WHICH admin resolved a request; listing needs no token. Until the
first admin exists, approve and deny need none either.
`

const MS_PER_MINUTE = 60_000
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

  const [first] = entries
  if (first === undefined) {
    io.stdout.write('no pending approvals\n')
    io.stderr.write(noPendingApprovalsHint())
    return 0
  }

  const truncationNote = truncated ? formatTruncationNote(entries.length, totalPending) : ''
  io.stdout.write(truncationNote + formatListReadable(entries, clock()))
  io.stderr.write(resolveApprovalHint(first.approvalId))
  return 0
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
  if (token === undefined || token === '') return actorWithoutToken(io, opts)

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

/**
 * No token: the resolution may still go ahead while the install has NO admin
 * (owner decision 2026-09-25) — the first `admin add` is token-free there, so
 * refusing kept nobody out. It is recorded under `NO_ADMINS_YET_ACTOR`, never
 * without an actor (ADR-0007 O3). An unreadable store refuses, fail closed.
 */
async function actorWithoutToken(io: ApprovalsCliIo, opts: ApprovalsCliOptions): Promise<string | undefined> {
  const emptiness = await adminStoreEmptiness(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {})
  // The note itself waits for the resolution to land (`runResolve`): said
  // before an unknown-id error, it described an action that never happened.
  if (emptiness.kind === 'empty') return NO_ADMINS_YET_ACTOR
  io.stderr.write(emptiness.kind === 'unreadable' ? storeUnreadableMessage(emptiness.detail) : MISSING_TOKEN_MESSAGE)
  return undefined
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
    io.stderr.write(`${NOT_FOUND_MESSAGE}\n${listApprovalsHint()}`)
    return 1
  }

  const safeId = formatReadableField(approvalId)
  io.stdout.write(outcome === 'approved' ? approvedMessage(safeId, result.record) : `Denied ${safeId}.\n`)
  if (actor === NO_ADMINS_YET_ACTOR) io.stderr.write(noAdminsYetNotice())
  return 0
}

/**
 * What the approval does for the call (0.2.3, stranger run of 0.2.2): while
 * the agent still waits, its call goes through at once — the old wording
 * promised only a "retry", and the call went on by itself 0.3 s later.
 * After the wait, only a retry within the grant window passes. A request
 * with no recorded wait (queued before M4) gets both halves.
 */
function approvedMessage(safeId: string, record: ResolvedApprovalFile): string {
  const grantMinutes = Math.round(DEFAULT_GRANT_TTL_MS / MS_PER_MINUTE)
  const retry =
    `the agent's retry within ${grantMinutes} minute(s) of this approval ` +
    `(default grant TTL; the active policy may override it) passes without a second approval`
  const waitEndsAt = record.waitExpiresAt === undefined ? undefined : Date.parse(record.waitExpiresAt)
  if (waitEndsAt === undefined || Number.isNaN(waitEndsAt)) {
    return `Approved ${safeId}. A call still waiting goes through now; once its wait has ended, ${retry}.\n`
  }
  return Date.parse(record.resolvedAt) < waitEndsAt
    ? `Approved ${safeId}. The waiting call goes through now.\n`
    : `Approved ${safeId}. The agent's wait had already ended: ${retry}.\n`
}
