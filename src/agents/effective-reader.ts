import type { GroupsStore } from '../groups/store.js'
import { materializeAgent } from './effective.js'
import type { AgentRecord } from './schema.js'
import type { AgentsStore } from './store.js'

/**
 * The agent-record source every consumer on the TRAFFIC path reads through
 * (M5.5 п.2, decisions G2/G5).
 *
 * `connect`, `serve` and the session's revocation watch used to read
 * `agents/store.ts` directly; each of them now reads this reader instead, so
 * exactly one place expands group membership into grants. `agents/scope.ts`,
 * `isRevokedFor`, the `Object.hasOwn(agent.grants, …)` checks in
 * `cli/connect-resolve.ts` and `grantsHashOf` are all unchanged — only the
 * SOURCE of the record differs, which is what makes "an agent granted through
 * a group behaves exactly like one granted personally" true by construction
 * rather than by twenty matching edits.
 *
 * Read-only by design: the reader exposes no mutation, and nothing on the
 * traffic path needs one. Grant edits go through the stores and reach a live
 * session through the watch's next poll.
 *
 * A failure to read the groups document PROPAGATES; it is never softened into
 * "no groups". The two callers both handle it correctly and differently: the
 * watch keeps its last known-good scope on a poll error (`agent-watch.ts`),
 * and session start refuses. Answering with a silently narrowed matrix
 * instead would deny an agent its granted traffic while every log line said
 * the plane was healthy — the failure mode a fail-closed system must still
 * make visible.
 */

/** What the traffic path needs from an agent source: two reads, no writes. */
export interface EffectiveAgentReader {
  /** The named agent with its effective grants, or `undefined` if there is none. */
  getAgent(name: string): Promise<AgentRecord | undefined>
  /** The agent owning `token` with its effective grants; revoked tokens resolve to `undefined`. */
  findAgentByToken(token: string): Promise<AgentRecord | undefined>
}

export interface EffectiveAgentReaderDeps {
  readonly agents: Pick<AgentsStore, 'getAgent' | 'findAgentByToken'>
  readonly groups: Pick<GroupsStore, 'groupsOf'>
}

export function createEffectiveAgentReader(deps: EffectiveAgentReaderDeps): EffectiveAgentReader {
  /**
   * Groups are read only AFTER an agent resolves: an unknown token must not
   * cost a second store read, and `undefined` passes straight through so the
   * reader stays indistinguishable from the bare store for that case.
   */
  async function materialize(record: AgentRecord | undefined): Promise<AgentRecord | undefined> {
    if (record === undefined) return undefined
    return materializeAgent(record, await deps.groups.groupsOf(record.name))
  }

  return {
    getAgent: async (name) => materialize(await deps.agents.getAgent(name)),
    findAgentByToken: async (token) => materialize(await deps.agents.findAgentByToken(token)),
  }
}
