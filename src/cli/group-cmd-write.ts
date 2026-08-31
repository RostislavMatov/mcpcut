import { journalAccessEdit } from '../groups/journal-access-edit.js'
import type { AccessEditInfo } from '../journal/access-edit-record.js'
import { requireAdminFromEnv, type AdminRefusalWording, type RequiredAdmin } from './admin-token.js'
import { GROUP_MIN_ROLE } from './group-cmd-args.js'
import { auditLineOf, type GroupOp } from './group-cmd-format.js'
import type { GroupCliIo, GroupCliOptions } from './group-cmd.js'

/**
 * The shared write path of a `group` mutation: the owner gate in front of it
 * and the two records behind it — the stderr audit line and the `access-edit`
 * journal record (ADR-0009 O5/O6). Kept out of `group-cmd.ts` so each
 * subcommand there reads as "parse, refuse, write, record".
 *
 * Only types are imported back from `group-cmd.ts`, so the two modules share
 * no runtime edge.
 */

/** How the shared token gate names this command's refusals. */
const GROUP_REFUSAL: AdminRefusalWording = {
  action: 'change groups',
  noun: 'change',
  verb: 'may not change groups',
  roleDetail: 'the same rule the admin UI applies to the /groups routes',
}

/** The owner behind `MCP_ADMIN_TOKEN`, or `undefined` with the refusal already printed. */
export async function requireOwner(
  io: GroupCliIo,
  opts: GroupCliOptions,
): Promise<RequiredAdmin | undefined> {
  return requireAdminFromEnv(
    {
      ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    },
    GROUP_MIN_ROLE,
    io,
    GROUP_REFUSAL,
  )
}

/**
 * The audit line plus the journal record of one applied change. The change is
 * ALREADY written when this runs, so a journal that cannot be reached is said
 * out loud and the command still exits 0 — mirroring `policy set` (a dropped
 * record must not be hidden, and must not fake a failed edit either).
 */
export async function recordChange(
  io: GroupCliIo,
  opts: GroupCliOptions,
  actor: RequiredAdmin,
  op: GroupOp,
  target: string,
  info: Omit<AccessEditInfo, 'actor'>,
): Promise<number> {
  io.stderr.write(auditLineOf(op, actor, target))
  const outcome = await journalAccessEdit({
    info: { ...info, actor: { adminName: actor.adminName, role: actor.role, via: 'cli' } },
    ...(opts.journalDir !== undefined ? { dir: opts.journalDir } : {}),
    ...(opts.clock !== undefined ? { clock: clockMsOf(opts.clock) } : {}),
    ...(opts.deps?.sink !== undefined ? { sinkOptions: opts.deps.sink } : {}),
    diagnostics: (line: string) => io.stderr.write(line),
  })
  if (!outcome.written) {
    io.stderr.write(
      '[journal] the group change was applied, but its journal record was dropped (see the sink diagnostics above)\n',
    )
  }
  return 0
}

/** The store's `Date` clock as the journal's epoch-milliseconds clock. */
function clockMsOf(clock: () => Date): () => number {
  return () => clock().getTime()
}
