import type { AccessEditInfo } from '../journal/access-edit-record.js'
import type { AdminRefusalWording, RequiredAdmin } from './admin-token.js'
import {
  recordAccessChange,
  requireAccessOwner,
  type AccessActor,
  type AccessOp,
  type AccessWriteOptions,
} from './access-cmd-write.js'
import type { AdminCliIo, AdminCliOptions } from './admin-cmd.js'

/**
 * The `admin` half of the shared access write path (`access-cmd-write.ts`):
 * the owner gate in front of `admin add|list|rotate|role|remove` and the two
 * records behind every mutation — the stderr audit line and the `access-edit`
 * journal record.
 *
 * Owner decision 2026-09-06: an admin IS the authority every other record is
 * attributed to, so the command that mints, rotates, re-roles or removes one
 * had to join `vault set|remove|rekey` (S2) and `agent *` / `group *`
 * (T1–T5) behind the SAME gate and the SAME record. Until then `admin *` took
 * no token and left no trace, which meant a journal whose chain of
 * attribution stopped one link short of its own root: every record said which
 * admin acted, and nothing said who had made that admin.
 *
 * Two paths stay token-free by construction, and both are still RECORDED,
 * with `UNATTRIBUTED_ACTOR`:
 *   - the FIRST `admin add` of an empty store — nobody holds a token yet;
 *   - `admin rotate --recover` — the way back in when the last owner lost
 *     theirs. It is not a hole in a barrier: a process under the same uid
 *     rewrites `admins.json` regardless (ADR-0003, ADR-0004 threat model), so
 *     the honest design is a named path that leaves a record, not a missing
 *     one that leaves none.
 *
 * `admin list` is gated too — the roster names every human who can reach this
 * plane, which is exactly what `GET /admins → owner` says in `ui/authz.ts` —
 * but writes no record: reading is not a change.
 *
 * Only types are imported back from `admin-cmd.ts`, so the two modules share
 * no runtime edge.
 */

/** How the shared token gate names a MUTATION's refusals. */
const ADMIN_REFUSAL: AdminRefusalWording = {
  action: 'change admins',
  noun: 'change',
  verb: 'may not manage admins',
  roleDetail: 'the same rule the admin UI applies to the /admins routes',
}

/** How it names `admin list`'s refusals: the same gate, a reading verb. */
const ADMIN_LIST_REFUSAL: AdminRefusalWording = {
  ...ADMIN_REFUSAL,
  action: 'list admins',
  // A read, not a change: nothing is attributed, the listing is simply owner-only.
  purpose: 'because the list of admins is for owners, as in the admin UI',
}

/**
 * The admin command's seams in the shared write path's terms. ONE clock seam:
 * the `now` that stamps `createdAt`/`rotatedAt` also stamps the journal
 * record, so a test (or an auditor) never sees the two disagree.
 */
export function accessWriteOptionsOf(opts: AdminCliOptions): AccessWriteOptions {
  return {
    ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
  }
}

/** The owner behind `MCP_ADMIN_TOKEN`, or `undefined` with the refusal already printed. */
export async function requireOwner(
  io: AdminCliIo,
  opts: AdminCliOptions,
): Promise<RequiredAdmin | undefined> {
  return requireAccessOwner(io, accessWriteOptionsOf(opts), ADMIN_REFUSAL)
}

/** The same gate in front of `admin list`, refusing in reading words. */
export async function requireListOwner(
  io: AdminCliIo,
  opts: AdminCliOptions,
): Promise<RequiredAdmin | undefined> {
  return requireAccessOwner(io, accessWriteOptionsOf(opts), ADMIN_LIST_REFUSAL)
}

/**
 * The audit line plus the journal record of one applied admin change, written
 * AFTER the store change (like vault) so a record never claims something that
 * did not happen.
 *
 * The `info` never carries the one-time token `add`/`rotate` printed: the
 * record shape has no field for a secret and must not grow one — the journal
 * is readable by every owner, while the token is shown to the operator
 * exactly once (pinned by `tests/cli/admin-cmd.test.ts`).
 */
export async function recordChange(
  io: AdminCliIo,
  opts: AdminCliOptions,
  actor: AccessActor,
  op: AccessOp,
  target: string,
  info: Omit<AccessEditInfo, 'actor'>,
): Promise<number> {
  return recordAccessChange({
    io,
    opts: accessWriteOptionsOf(opts),
    actor,
    subject: 'admin',
    op,
    target,
    info,
  })
}
