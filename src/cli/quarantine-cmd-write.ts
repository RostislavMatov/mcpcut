import { QUARANTINE_RESOLVE_MIN_ROLE } from '../admin/authz.js'
import {
  pairTarget,
  recordAccessChange,
  type AccessWriteOptions,
} from './access-cmd-write.js'
import { requireAdminFromEnv, type AdminRefusalWording, type RequiredAdmin } from './admin-token.js'
import type { QuarantineCliIo, RunQuarantineOptions } from './quarantine-cmd.js'

/**
 * The `quarantine` half of the shared access write path
 * (`access-cmd-write.ts`): the operator gate in front of `approve`,
 * `approve --all` and `reject`, and the two records behind each — the stderr
 * audit line and the `access-edit` journal record.
 *
 * Owner decision Q17 (2026-09-08). Releasing a tool from quarantine widens
 * what every agent granted that server can reach, which is the same category
 * of fact as a grant; the web UI has always treated it that way
 * (`POST /quarantine/{approve,reject}`, `operator`, attributed through
 * `handlers/quarantine.ts`), while the CLI took no token and named nobody.
 * That made the UI row a barrier a shell walked around, and left a journal in
 * which a tool starts being called with no record of who let it out.
 *
 * The threshold is the SHARED constant, not a second copy of `'operator'`, so
 * the two surfaces cannot drift. As everywhere else in this product, the token
 * buys ATTRIBUTION and parity, not an access barrier: a process under the same
 * uid edits `state.db` directly (ADR-0004).
 *
 * `list` and `show` stay token-free — reading a schema diff decides nothing.
 *
 * Only types are imported back from `quarantine-cmd.ts`, so the two modules
 * share no runtime edge.
 */

/** How the shared token gate names this command's refusals. */
const QUARANTINE_REFUSAL: AdminRefusalWording = {
  action: 'resolve a quarantined tool',
  noun: 'release',
  verb: 'may not release quarantined tools',
  roleDetail: 'the same rule the admin UI applies to POST /quarantine/approve',
}

/** Which mutation a record and its audit line describe. */
export type QuarantineResolution = 'approve' | 'reject'

/** The command's options in the shared write path's terms. */
export function accessWriteOptionsOf(opts: RunQuarantineOptions): AccessWriteOptions {
  return {
    ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  }
}

/**
 * The operator behind `MCP_ADMIN_TOKEN`, or `undefined` with the refusal
 * already printed. Called BEFORE the inventory store is touched: a refused
 * release must leave the quarantine exactly as it found it.
 */
export async function requireQuarantineAdmin(
  io: QuarantineCliIo,
  opts: RunQuarantineOptions,
): Promise<RequiredAdmin | undefined> {
  return requireAdminFromEnv(
    accessWriteOptionsOf(opts),
    QUARANTINE_RESOLVE_MIN_ROLE,
    io,
    QUARANTINE_REFUSAL,
  )
}

/**
 * The audit line plus the journal record of ONE applied release. The change is
 * already written when this runs, so a journal that cannot be reached is said
 * out loud and the command still succeeds — the same rule the rest of the
 * shared write path follows.
 *
 * `approve --all` calls this once per tool rather than once per command: an
 * auditor asking "who released THIS tool" must get an answer that names the
 * tool, and a single record listing a batch would answer a different question.
 */
export async function recordQuarantineResolution(
  io: QuarantineCliIo,
  opts: RunQuarantineOptions,
  actor: RequiredAdmin,
  resolution: QuarantineResolution,
  serverName: string,
  toolName: string,
): Promise<number> {
  return recordAccessChange({
    io,
    opts: accessWriteOptionsOf(opts),
    actor,
    subject: 'quarantine',
    op: resolution,
    target: pairTarget(serverName, toolName),
    info: {
      action: resolution === 'approve' ? 'quarantine.approve' : 'quarantine.reject',
      server: serverName,
      tool: toolName,
    },
  })
}
