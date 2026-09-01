import { createGroupsStore } from '../groups/store.js'
import type { AccessEditInfo } from '../journal/access-edit-record.js'
import { formatReadableField } from '../journal/format.js'
import type { AdminRefusalWording, RequiredAdmin } from './admin-token.js'
import { recordAccessChange, requireAccessOwner, type AccessOp } from './access-cmd-write.js'
import type { AgentCliIo, AgentCliOptions } from './agent-cmd.js'

/**
 * The `agent` half of the shared access write path (`access-cmd-write.ts`):
 * the owner gate in front of every mutation and the two records behind it.
 *
 * Owner decision T4 (2026-09-01) put `agent create|grant|ungrant|revoke`
 * behind the same `MCP_ADMIN_TOKEN` (role `owner`) gate as `group *`, and T1
 * gave each of them an `access-edit` journal record. The rationale is G2: a
 * personal grant is the NARROWING instrument (it shadows the agent's groups
 * for that server wholesale), so removing one WIDENS effective access — an
 * operation that must be attributable, not anonymous.
 *
 * Only types are imported back from `agent-cmd.ts`, so the two modules share
 * no runtime edge.
 */

/** How the shared token gate names this command's refusals. */
const AGENT_REFUSAL: AdminRefusalWording = {
  action: 'change agent identities or grants',
  noun: 'change',
  verb: 'may not change agent grants',
  roleDetail: 'the same rule the admin UI applies to the /agents routes',
}

/** The owner behind `MCP_ADMIN_TOKEN`, or `undefined` with the refusal already printed. */
export async function requireOwner(
  io: AgentCliIo,
  opts: AgentCliOptions,
): Promise<RequiredAdmin | undefined> {
  return requireAccessOwner(io, opts, AGENT_REFUSAL)
}

/**
 * The audit line plus the journal record of one applied agent change.
 *
 * The `info` never carries the token `agent create` printed: the record shape
 * has no field for a secret and must not grow one — the journal is readable by
 * every viewer admin, while the token is shown to the operator exactly once
 * (pinned by `tests/cli/agent-cmd-token.test.ts`).
 */
export async function recordChange(
  io: AgentCliIo,
  opts: AgentCliOptions,
  actor: RequiredAdmin,
  op: AccessOp,
  target: string,
  info: Omit<AccessEditInfo, 'actor'>,
): Promise<number> {
  return recordAccessChange({ io, opts, actor, subject: 'agent', op, target, info })
}

/**
 * A personal grant takes its server WHOLE, shadowing whatever the agent's
 * groups grant for it (ADR-0010 §2). Removing it therefore does not deny the
 * server — it hands the agent the groups' (unioned, usually wider) grant. The
 * shell is told so, because "removed grant" alone reads as de-escalation.
 *
 * Read AFTER the write, so the groups named are the ones the agent actually
 * falls back to now. A groups document that cannot be read must not turn a
 * completed ungrant into a failure: the removal happened either way, and the
 * warning is advisory (the journal record of the ungrant is written regardless
 * — the widening is an ordinary `agent.ungrant`, T1).
 */
export async function warnIfGroupsUncovered(
  agentName: string,
  serverName: string,
  io: AgentCliIo,
  options: AgentCliOptions,
): Promise<void> {
  let inheritedFrom: readonly string[]
  try {
    const memberships = await createGroupsStore(
      options.journalDir !== undefined ? { journalDir: options.journalDir } : {},
    ).groupsOf(agentName)
    inheritedFrom = memberships
      .filter((group) => Object.hasOwn(group.grants, serverName))
      .map((group) => group.name)
  } catch (error: unknown) {
    // Advisory, but never silent: "I could not look" must be distinguishable
    // from "there is nothing to warn about" — same shape as
    // `server-grant-refs.ts`'s failed lookup. The ungrant itself already
    // landed, so the exit code stays 0.
    const reason = error instanceof Error ? error.message : String(error)
    io.stderr.write(
      `[warn] could not check group grants for ${formatReadableField(agentName)}: ${reason}\n`,
    )
    return
  }
  if (inheritedFrom.length === 0) return
  const from = inheritedFrom.map((name) => `group:${formatReadableField(name)}`).join(', ')
  io.stderr.write(
    `[warn] ${formatReadableField(agentName)} now inherits ${formatReadableField(serverName)}` +
      ` from ${from} — effective access WIDENED\n`,
  )
}
