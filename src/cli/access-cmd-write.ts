import { journalAccessEdit } from '../groups/journal-access-edit.js'
import type { AccessEditInfo } from '../journal/access-edit-record.js'
import { formatReadableField } from '../journal/format.js'
import type { JournalSinkOptions } from '../journal/sink.js'
import type { Role } from '../admin/authz.js'
import { requireAdminFromEnv, type AdminRefusalWording, type RequiredAdmin } from './admin-token.js'

/**
 * The shared write path of every CLI command that changes WHO CAN REACH WHAT:
 * the owner gate in front of it and the two records behind it — the stderr
 * audit line and the `access-edit` journal record (ADR-0009 O5/O6,
 * ADR-0010 §4).
 *
 * `group *` phrased this first; owner decision T4 (2026-09-01) put personal
 * grants (`agent create|grant|ungrant|revoke`) behind the SAME gate, so the
 * two commands share one implementation rather than two that drift. The
 * subject (`group` / `agent`) is the only thing that differs in the output.
 *
 * The token buys ATTRIBUTION and parity with the admin UI's role table, not an
 * access barrier: a process under the same uid edits the store document
 * directly (ADR-0003, ADR-0004).
 */

/** Minimum role for every access mutation, CLI and UI alike (G4, T4). */
export const ACCESS_MIN_ROLE: Role = 'owner'

/** Which store the change landed in — the first word of the audit line. */
export type AccessSubject = 'group' | 'agent'

/** The mutating subcommands, as they appear in the audit line. */
export type AccessOp = 'create' | 'remove' | 'grant' | 'ungrant' | 'join' | 'leave' | 'revoke'

/** Minimal stderr shape the audit line and refusals are written to. */
export interface AccessWriteIo {
  readonly stderr: { write(chunk: string): unknown }
}

/** The seams both command families thread through: stores, clock, journal sink. */
export interface AccessWriteOptions {
  /** Directory holding `state.db` and `journal.db`. Defaults to `JOURNAL_DIR`. */
  readonly journalDir?: string
  /** Environment holding `MCP_ADMIN_TOKEN`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Clock override for deterministic timestamps in tests. */
  readonly clock?: () => Date
  /** @internal test-only sink seams (retry delay, fault-injected commit). */
  readonly deps?: {
    readonly sink?: Pick<JournalSinkOptions, 'retryDelayMs' | 'commitBatchImpl'>
  }
}

/** The owner behind `MCP_ADMIN_TOKEN`, or `undefined` with the refusal already printed. */
export async function requireAccessOwner(
  io: AccessWriteIo,
  opts: AccessWriteOptions,
  wording: AdminRefusalWording,
): Promise<RequiredAdmin | undefined> {
  return requireAdminFromEnv(
    {
      ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    },
    ACCESS_MIN_ROLE,
    io,
    wording,
  )
}

/**
 * The audit line every successful mutation writes to stderr (ADR-0009 O5:
 * a store change made from a shell says who made it, right there in the
 * terminal, whether or not the journal record lands).
 */
export function auditLineOf(
  subject: AccessSubject,
  op: AccessOp,
  actor: RequiredAdmin,
  target: string,
): string {
  return `[audit] ${subject} ${op} by ${formatReadableField(actor.adminName)} (${actor.role}): ${target}\n`
}

/** `<group>/<server>` or `<agent>/<server>` — the two-part target, both halves sanitized. */
export function pairTarget(first: string, second: string): string {
  return `${formatReadableField(first)}/${formatReadableField(second)}`
}

export interface RecordAccessChangeInput {
  readonly io: AccessWriteIo
  readonly opts: AccessWriteOptions
  readonly actor: RequiredAdmin
  readonly subject: AccessSubject
  readonly op: AccessOp
  /** The names the change touched, already sanitized for the terminal. */
  readonly target: string
  readonly info: Omit<AccessEditInfo, 'actor'>
}

/**
 * The audit line plus the journal record of one applied change, and the exit
 * code (always 0). The change is ALREADY written when this runs, so a journal
 * that cannot be reached is said out loud and the command still succeeds —
 * mirroring `policy set` (a dropped record must not be hidden, and must not
 * fake a failed edit either).
 */
export async function recordAccessChange(input: RecordAccessChangeInput): Promise<number> {
  const { io, opts, actor, subject } = input
  io.stderr.write(auditLineOf(subject, input.op, actor, input.target))
  const outcome = await journalAccessEdit({
    info: { ...input.info, actor: { adminName: actor.adminName, role: actor.role, via: 'cli' } },
    ...(opts.journalDir !== undefined ? { dir: opts.journalDir } : {}),
    ...(opts.clock !== undefined ? { clock: clockMsOf(opts.clock) } : {}),
    ...(opts.deps?.sink !== undefined ? { sinkOptions: opts.deps.sink } : {}),
    diagnostics: (line: string) => io.stderr.write(line),
  })
  if (!outcome.written) {
    io.stderr.write(
      `[journal] the ${subject} change was applied, but its journal record was dropped ` +
        '(see the sink diagnostics above)\n',
    )
  }
  return 0
}

/** The store's `Date` clock as the journal's epoch-milliseconds clock. */
function clockMsOf(clock: () => Date): () => number {
  return () => clock().getTime()
}
