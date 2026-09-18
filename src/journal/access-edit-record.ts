import { ulid } from 'ulid'
import type { AdminRole } from '../admin/constants.js'
import type { AgentGrant } from '../agents/schema.js'
import { redact } from '../redact/redact.js'
import { SECRET_NAME_PATTERN } from '../vault/constants.js'
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
 * from `agents/schema.ts`, which the group store already shares (G1). The
 * vault's NAME pattern is borrowed the same way (`vault/constants.ts` holds
 * constants only; `signing.ts` already reaches into `vault/files.ts`).
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
  // Registering a server (user-journey smoke 2026-09-18, UX-9). Its mirror
  // image has been recorded since M5.5 п.2, while the command that decides
  // WHICH process the plane may launch — and, through the registration probe,
  // runs it once — left no record at all. Since owner decision 2026-09-18 the
  // CLI `server add|remove` REQUIRE an owner `MCP_ADMIN_TOKEN`, so the actor
  // is a named owner on both surfaces: no token is a refusal, not a record
  // with nobody named.
  | 'server.add'
  // Editing a registration (owner decision 2026-09-18): re-pointing a stdio
  // command is the same remote-code-execution power as registering one, so it
  // earns the same record. The web UI is the only surface with an edit today.
  | 'server.update'
  | 'server.remove'
  // Personal grants (owner decision T1, 2026-09-01): the same category as
  // group edits, so the journal answers "who changed this agent's matrix".
  | 'agent.create'
  | 'agent.grant'
  | 'agent.ungrant'
  | 'agent.revoke'
  // Vault mutations (owner decision S2, 2026-09-03): replacing a secret
  // replaces the identity a server uses against an external system, so the
  // journal must show WHO swapped it — by the secret's name, never its value.
  | 'vault.set'
  | 'vault.remove'
  | 'vault.rekey'
  // Admin identities (owner decision 2026-09-06): an admin IS the authority
  // every other record is attributed to, so who minted, rotated, re-roled or
  // removed one belongs in the same category — otherwise the chain of
  // attribution stops one link short of its own root.
  | 'admin.add'
  | 'admin.rotate'
  | 'admin.role'
  | 'admin.remove'
  // Quarantine releases and the host operations (owner decision Q17,
  // 2026-09-08). Letting a tool out of quarantine widens what every agent
  // granted that server can reach — the same category of fact as a grant —
  // and the four host operations below say who minted the key an auditor
  // checks a report against, who copied the databases elsewhere, who imported
  // legacy state and who signed the chain head. `prune` is the one that
  // matters most: it is the only command in the product that DELETES
  // evidence, and its own signed marker names no admin.
  | 'quarantine.approve'
  | 'quarantine.reject'
  | 'prune'
  | 'keygen'
  | 'backup'
  | 'migrate'
  | 'verify.sign'

/**
 * WHO made the change: the authenticated admin, their role at the time, and
 * the surface. Both name and role are `null` on the two paths where there is
 * genuinely nobody to name — the bootstrap `admin add` on an empty store
 * (nobody holds a token yet) and `admin rotate --recover` (the way back in
 * when the last owner lost theirs). "Nobody named" is a fact about that
 * shell, kept verbatim rather than faked into a name. Journals written before
 * 2026-09-18 also carry it on CLI `server add|remove`, which ran without a
 * token until the owner gate; a reader must keep accepting those records.
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
  /**
   * `vault.set` / `vault.remove`: the NAME of the secret (S2) — never its
   * value; the record has no field for one and must not grow one. The builder
   * holds this to the vault's own name pattern, so a value handed over where
   * the name belongs is refused rather than written. `vault.rekey` names none.
   *
   * Not called `secret`: the journal's redaction (the single path in) blanks
   * the value of ANY key containing that word (`REDACT_KEY_PATTERNS`), and an
   * exemption would weaken the invariant for one field. `vaultEntry` passes
   * both the substring and the whole-token rules and says what it holds.
   */
  readonly vaultEntry?: string
  /**
   * `quarantine.approve` / `quarantine.reject` (Q17): the tool that was let
   * out or discarded, beside the `server` it belongs to. The name comes from
   * the upstream server and is untrusted like every other name here — it goes
   * through the same redaction path, and every terminal that prints it back
   * runs it through `formatReadableField` first.
   */
  readonly tool?: string
  /** `prune` (Q17): the retention window as the operator typed it, e.g. `90d`. */
  readonly olderThan?: string
  /** `prune` (Q17): how many records the delete actually removed. */
  readonly deletedCount?: number
  /** `prune` (Q17): the last seq the delete covered — the marker's own number. */
  readonly prunedThroughSeq?: number
  /** `backup` (Q17): the directory the databases were copied into. */
  readonly dest?: string
  /**
   * `keygen` / `verify.sign` (Q17): which key was minted or signed with, by
   * its public fingerprint. Never key material — the record has no field for
   * one and must not grow one.
   */
  readonly keyFingerprint?: string
  /** The grant written by `group.grant` — the same shape agents carry (G1). */
  readonly grant?: AgentGrant
  /**
   * `admin.*`: the admin the change is ABOUT, by name (owner decision
   * 2026-09-06). Never the same field as `actor.adminName`, which says who
   * made it — an owner rotating their own token fills both with one name, and
   * the record still has to say which is which.
   */
  readonly admin?: string
  /** `admin.add` / `admin.role`: the role the admin was given. */
  readonly targetRole?: AdminRole
  /**
   * `admin.rotate --recover` only: this rotation ran with no admin token, the
   * break-glass path for an owner who lost theirs. Present ONLY when true, so
   * an auditor scanning for the flag finds the recoveries and nothing else.
   */
  readonly recovery?: true
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
  assertSecretName(input.info.vaultEntry)
  const now = input.clock ?? Date.now
  const record: JournalRecord = {
    id: ulid(),
    ts: new Date(now()).toISOString(),
    sessionId: ACCESS_EDIT_SESSION_ID,
    direction: ACCESS_EDIT_DIRECTION,
    kind: 'access-edit',
    payload: payloadOf(input.info),
  }
  return Object.freeze(record)
}

/**
 * The redacted payload with `vaultEntry` spliced back in verbatim. The name
 * has already passed `SECRET_NAME_PATTERN` — a closed vocabulary, never free
 * text — yet a legitimate name such as `sk-openai-prod-key` matches the
 * VALUE patterns the redactor uses for real keys and would come out as
 * `[REDACTED]`, erasing the one fact decision S2 keeps: which secret was
 * swapped (review of the 2026-09-03 change). Everything else stays under the
 * single redaction path.
 */
function payloadOf(info: AccessEditInfo): unknown {
  const redacted = redact(flatInfoOf(info))
  if (info.vaultEntry === undefined || typeof redacted !== 'object' || redacted === null) return redacted
  return { ...(redacted as Record<string, unknown>), vaultEntry: info.vaultEntry }
}

/**
 * The one field of this kind whose VALUE could be mistaken for a secret. A
 * caller that hands the secret where its name belongs is refused — and refused
 * without the string being repeated: the journal's writer prints builder
 * errors to stderr (`journalAccessEdit`), which must never become the leak.
 */
function assertSecretName(vaultEntry: string | undefined): void {
  if (vaultEntry === undefined || SECRET_NAME_PATTERN.test(vaultEntry)) return
  throw new Error(
    `access-edit: "vaultEntry" must be a vault secret name matching ${SECRET_NAME_PATTERN}`,
  )
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
    ...(info.tool !== undefined ? { tool: info.tool } : {}),
    ...(info.olderThan !== undefined ? { olderThan: info.olderThan } : {}),
    ...(info.deletedCount !== undefined ? { deletedCount: info.deletedCount } : {}),
    ...(info.prunedThroughSeq !== undefined ? { prunedThroughSeq: info.prunedThroughSeq } : {}),
    ...(info.dest !== undefined ? { dest: info.dest } : {}),
    ...(info.keyFingerprint !== undefined ? { keyFingerprint: info.keyFingerprint } : {}),
    ...(info.vaultEntry !== undefined ? { vaultEntry: info.vaultEntry } : {}),
    ...(info.admin !== undefined ? { admin: info.admin } : {}),
    ...(info.targetRole !== undefined ? { targetRole: info.targetRole } : {}),
    ...(info.recovery !== undefined ? { recovery: info.recovery } : {}),
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
