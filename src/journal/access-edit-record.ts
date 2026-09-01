import { ulid } from 'ulid'
import type { AdminRole } from '../admin/constants.js'
import type { AgentGrant } from '../agents/schema.js'
import { redact } from '../redact/redact.js'
import type { ClientServerDirection, JournalRecord } from './record.js'

/**
 * The access-edit vocabulary and builder: what a `kind: 'access-edit'`
 * journal record says about one change to WHO CAN REACH WHAT (plan
 * m55-server-groups, owner decisions G4/G6). One change = ONE flat record —
 * the actor, the action, and the names it touched.
 *
 * Split out of `record.ts` the same way `probe-record.ts` and
 * `policy-edit-record.ts` were: `record.ts` owns the traffic-record builder
 * and stays the contract point (it re-exports these types), this module owns
 * the access-edit side.
 *
 * Layering: the journal must not depend on `src/groups/**` (the group store
 * depends on the journal, not the other way round), so the action union is
 * declared here in journal terms; only the grant SHAPE is borrowed as a type
 * from `agents/schema.ts`, which the group store already shares (G1).
 *
 * Attribution is separable from agent traffic BY CONSTRUCTION: the kind is
 * its own, the reserved `plane_access` session id can never be a registry
 * server name, and none of the decision-record fields (`decision`,
 * `agentName`, outcome filters) ever appear on an access-edit record — an
 * edit that GRANTS a server must never be counted as a call that WAS allowed.
 */

/**
 * The reserved `sessionId` access-edit records are written under. Same
 * construction as `PROBE_SESSION_ID` (`src/probe/constants.ts`) and
 * `POLICY_EDIT_SESSION_ID`: matches `SESSION_ID_PATTERN`, and the underscore
 * makes it impossible as a registry server name
 * (`REGISTRY_SERVER_NAME_PATTERN` rejects `_`). Pinned by
 * `tests/journal/access-edit-record.test.ts`.
 */
export const ACCESS_EDIT_SESSION_ID = 'plane_access'

/** Direction an access edit is stamped with: the plane acted, nothing was received. */
const ACCESS_EDIT_DIRECTION: ClientServerDirection = 'client→server'

/** Which surface the admin used. */
export type AccessEditVia = 'ui' | 'cli'

/** Every access change that gets its own record. `server.remove` is the cascade (G6). */
export type AccessEditAction =
  | 'group.create'
  | 'group.remove'
  | 'group.grant'
  | 'group.ungrant'
  | 'group.join'
  | 'group.leave'
  | 'server.remove'
  // Personal grants (owner decision T1, 2026-09-01): the same category as
  // group edits, so the journal answers "who changed this agent's matrix".
  | 'agent.create'
  | 'agent.grant'
  | 'agent.ungrant'
  | 'agent.revoke'

/**
 * WHO made the change: the authenticated admin, their role at the time, and
 * the surface. Both name and role are `null` ONLY for an unattributed CLI
 * `server remove` (no admin token in the environment) — "nobody named" is a
 * fact about that shell, kept verbatim rather than faked into a name.
 */
export interface AccessEditActor {
  readonly adminName: string | null
  readonly role: AdminRole | null
  readonly via: AccessEditVia
}

/**
 * Everything an `access-edit` record says, as the record's `payload` so the
 * existing search, UI journal and export surfaces render it with no special
 * casing. Which optional fields are present follows from the action: a
 * `group.create` names only the group, a `group.join` names group + agent, a
 * `server.remove` names the server plus what the cascade touched.
 */
export interface AccessEditInfo {
  readonly actor: AccessEditActor
  readonly action: AccessEditAction
  readonly group?: string
  readonly server?: string
  readonly agent?: string
  /** The grant written by `group.grant` — the same shape agents carry (G1). */
  readonly grant?: AgentGrant
  /** `server.remove` cascade: agents whose personal grant for the server was dropped. */
  readonly affectedAgents?: readonly string[]
  /** `server.remove` cascade: groups whose grant for the server was dropped. */
  readonly affectedGroups?: readonly string[]
  /**
   * `server.remove` only: whether each half of the cascade actually ran. The
   * three documents (registry, `agents.json`, `groups.json`) do not share a
   * transaction, so one half can fail while the other lands; the record must
   * say which, or an auditor reading `affectedGroups: []` cannot tell "no
   * group granted it" from "the groups store could not be read".
   */
  readonly cascade?: CascadeVerdict
}

/** Per-half outcome of the `server remove` cascade. */
export interface CascadeVerdict {
  readonly agents: CascadeHalfStatus
  readonly groups: CascadeHalfStatus
}

export type CascadeHalfStatus = 'done' | 'failed'

export interface BuildAccessEditRecordInput {
  readonly info: AccessEditInfo
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  readonly clock?: () => number
}

/**
 * Builds a frozen, redacted `kind: 'access-edit'` journal record under the
 * reserved session. The whole payload goes through `redact()` — the single
 * path into the journal — even though none of the fields should carry a
 * secret: group, server and agent names plus `adminName` are externally
 * sourced strings, and one choke point covers every present and future
 * producer the same way `policy-edit-record.ts` does.
 */
export function buildAccessEditRecord(input: BuildAccessEditRecordInput): JournalRecord {
  const now = input.clock ?? Date.now
  const record: JournalRecord = {
    id: ulid(),
    ts: new Date(now()).toISOString(),
    sessionId: ACCESS_EDIT_SESSION_ID,
    direction: ACCESS_EDIT_DIRECTION,
    kind: 'access-edit',
    payload: redact(flatInfoOf(input.info)),
  }
  return Object.freeze(record)
}

/**
 * The payload object, assembled field by field so nothing beyond the contract
 * rides along and an absent optional stays ABSENT instead of becoming an
 * `undefined`-valued key (the codebase's "absent, not null" convention).
 */
function flatInfoOf(info: AccessEditInfo): Record<string, unknown> {
  return {
    actor: { adminName: info.actor.adminName, role: info.actor.role, via: info.actor.via },
    action: info.action,
    ...(info.group !== undefined ? { group: info.group } : {}),
    ...(info.server !== undefined ? { server: info.server } : {}),
    ...(info.agent !== undefined ? { agent: info.agent } : {}),
    ...(info.grant !== undefined ? { grant: flatGrantOf(info.grant) } : {}),
    ...(info.affectedAgents !== undefined ? { affectedAgents: [...info.affectedAgents] } : {}),
    ...(info.affectedGroups !== undefined ? { affectedGroups: [...info.affectedGroups] } : {}),
    ...(info.cascade !== undefined ? { cascade: flatCascadeOf(info.cascade) } : {}),
  }
}

/** The cascade verdict, field by field, for the same no-extra-keys reason. */
function flatCascadeOf(cascade: CascadeVerdict): Record<string, unknown> {
  return { agents: cascade.agents, groups: cascade.groups }
}

/** The grant, field by field, for the same reason: no extra key can ride in on a stored object. */
function flatGrantOf(grant: AgentGrant): Record<string, unknown> {
  return {
    tools: grant.tools,
    ...(grant.resources !== undefined ? { resources: grant.resources } : {}),
    ...(grant.prompts !== undefined ? { prompts: grant.prompts } : {}),
  }
}
