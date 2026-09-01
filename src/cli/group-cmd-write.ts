import type { AccessEditInfo } from '../journal/access-edit-record.js'
import type { AdminRefusalWording, RequiredAdmin } from './admin-token.js'
import { recordAccessChange, requireAccessOwner } from './access-cmd-write.js'
import type { GroupOp } from './group-cmd-format.js'
import type { GroupCliIo, GroupCliOptions } from './group-cmd.js'

/**
 * The `group` half of the shared access write path (`access-cmd-write.ts`):
 * this module only binds the subject and this command's refusal wording, so
 * each subcommand in `group-cmd.ts` reads as "parse, refuse, write, record".
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
  return requireAccessOwner(io, opts, GROUP_REFUSAL)
}

/** The audit line plus the journal record of one applied group change. */
export async function recordChange(
  io: GroupCliIo,
  opts: GroupCliOptions,
  actor: RequiredAdmin,
  op: GroupOp,
  target: string,
  info: Omit<AccessEditInfo, 'actor'>,
): Promise<number> {
  return recordAccessChange({ io, opts, actor, subject: 'group', op, target, info })
}
