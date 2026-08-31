import type { GroupRecord } from '../groups/schema.js'
import type { AgentGrant, AgentRecord } from './schema.js'

/**
 * Effective grants of one agent: its personal matrix widened by the groups it
 * belongs to (M5.5 п.2, decision G2).
 *
 * The merge rule is PER SERVER and deliberately not per field:
 *
 *  - a personal grant for server X wins WHOLESALE — the groups' grants for X
 *    are not merged into it, not even the fields the personal grant leaves
 *    absent. An operator who narrowed one agent's access to a server did so
 *    against the whole grant; letting a group leak `resources: '*'` back in
 *    would silently undo that;
 *  - otherwise every group the agent is a member of that grants X contributes,
 *    and the contributions are UNIONED (groups only ever widen — subtracting
 *    groups are out of scope, denial belongs to policy).
 *
 * Union of one field: `'*'` anywhere absorbs the lists ("everything" cannot be
 * narrowed by adding names); otherwise the lists are concatenated, sorted by
 * UTF-16 code unit and deduplicated. Sorting is by code unit, never
 * `localeCompare`, for the same reason `policy/provenance.ts` sorts that way:
 * the result is fingerprinted, and locale collation varies with the ICU data a
 * runtime was built against. Deduplication happens HERE because `grantsHashOf`
 * normalizes order but deliberately does not dedupe — two groups granting the
 * same tool must not produce a matrix whose hash depends on how many groups
 * happened to mention it.
 *
 * `resources` and `prompts` stay ABSENT when absent in every contributing
 * group: an absent field is the M3 fail-closed denial of those methods
 * (`agents/scope.ts`), and this module must never turn "no grant" into
 * "an empty grant that exists".
 *
 * Byte-identity gate: when no group contributes a server the agent did not
 * already hold, the personal matrix is returned BY REFERENCE and
 * `materializeAgent` returns the very same record. Every installation without
 * groups therefore keeps producing exactly the `grantsHash` it produced
 * before this module existed — a fingerprint that moved on an upgrade would
 * show an auditor an authorization change that never happened.
 *
 * Nothing here mutates its inputs, and every map lookup goes through
 * `Object.hasOwn` so a hostile server name cannot resolve through the
 * prototype chain (the schemas reject such names, but this module is one
 * `JSON.parse` away from untrusted data and does not rely on that).
 */

/** Where one server's effective grant came from. */
export type GrantSource =
  /** The agent's own grant. `shadowedGroups` names the groups it overrode (G2), for UI hints. */
  | { readonly kind: 'agent'; readonly shadowedGroups: readonly string[] }
  /** Inherited: the groups whose grants were unioned into this one. */
  | { readonly kind: 'group'; readonly groups: readonly string[] }

export interface EffectiveGrants {
  /** The matrix `agents/scope.ts` decides against; same shape as `AgentRecord.grants`. */
  readonly grants: Readonly<Record<string, AgentGrant>>
  /** Provenance per server, keyed exactly like `grants`. */
  readonly sources: Readonly<Record<string, GrantSource>>
}

/** The grant fields a group may leave out; `tools` is always present. */
type OptionalPatternField = 'resources' | 'prompts'

/** One pattern list exactly as a grant carries it (`AgentGrant.tools`'s own type). */
type PatternList = AgentGrant['tools']

/**
 * Order by UTF-16 code unit, never `localeCompare`. Shared with the stores
 * (`agents/store.ts`, `groups/store.ts`) because the arrays they sort end up
 * fingerprinted or written into `access-edit` journal records, and locale
 * collation varies with the ICU data a runtime was built against — the same
 * reason `policy/provenance.ts` sorts this way.
 */
export function compareAsText(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

/** Union of declared pattern lists: `'*'` absorbs, otherwise sorted and deduplicated. */
function unionValues(values: readonly PatternList[]): PatternList {
  const names = new Set<string>()
  for (const value of values) {
    if (value === '*') return '*'
    for (const pattern of value) names.add(pattern)
  }
  return [...names].sort(compareAsText)
}

/**
 * Union of an OPTIONAL field across contributing grants. `undefined` means
 * "no group declared this field", which the caller turns into an ABSENT key
 * rather than an empty list — an absent field is the fail-closed denial.
 */
function unionOptional(
  grants: readonly AgentGrant[],
  field: OptionalPatternField,
): PatternList | undefined {
  const declared = grants
    .map((grant) => grant[field])
    .filter((value): value is PatternList => value !== undefined)
  return declared.length === 0 ? undefined : unionValues(declared)
}

/** One merged grant from every group grant for the same server. */
function mergeGrants(grants: readonly AgentGrant[]): AgentGrant {
  const resources = unionOptional(grants, 'resources')
  const prompts = unionOptional(grants, 'prompts')
  return {
    // `tools` is required on every grant, so it needs no "was it declared?"
    // branch — unlike the two optional fields below.
    tools: unionValues(grants.map((grant) => grant.tools)),
    ...(resources !== undefined ? { resources } : {}),
    ...(prompts !== undefined ? { prompts } : {}),
  }
}

/** Server name -> the grants of the member groups that cover it, in input order. */
function collectGroupGrants(
  agentName: string,
  groups: readonly GroupRecord[],
): Map<string, { readonly groups: string[]; readonly grants: AgentGrant[] }> {
  const byServer = new Map<string, { groups: string[]; grants: AgentGrant[] }>()
  for (const group of groups) {
    if (!group.members.includes(agentName)) continue
    for (const [server, grant] of Object.entries(group.grants)) {
      const entry = byServer.get(server) ?? { groups: [], grants: [] }
      entry.groups.push(group.name)
      entry.grants.push(grant)
      byServer.set(server, entry)
    }
  }
  return byServer
}

/**
 * The agent's grants widened by the groups it belongs to. Groups the agent is
 * not a member of are ignored, so a caller may pass every group it has.
 */
export function effectiveGrantsOf(
  agent: AgentRecord,
  groups: readonly GroupRecord[],
): EffectiveGrants {
  const byServer = collectGroupGrants(agent.name, groups)
  const sources: Record<string, GrantSource> = {}
  const inherited: Record<string, AgentGrant> = {}
  let hasInherited = false

  for (const server of Object.keys(agent.grants)) {
    const contributed = byServer.get(server)
    sources[server] = { kind: 'agent', shadowedGroups: contributed?.groups ?? [] }
  }

  for (const [server, entry] of byServer) {
    // G2: a personal grant takes the server whole; the group grants are only
    // recorded as shadowed (above), never merged in.
    if (Object.hasOwn(agent.grants, server)) continue
    inherited[server] = mergeGrants(entry.grants)
    sources[server] = { kind: 'group', groups: entry.groups }
    hasInherited = true
  }

  // Reference identity when nothing was inherited — see the module doc.
  const grants = hasInherited ? { ...agent.grants, ...inherited } : agent.grants
  return { grants, sources }
}

/**
 * The record every consumer on the traffic path should see: identity and
 * revocation untouched, `grants` replaced by the effective matrix. Returns the
 * SAME object when no group contributes anything, which is what keeps
 * `grantsHash` stable for an installation without groups.
 */
export function materializeAgent(
  agent: AgentRecord,
  groups: readonly GroupRecord[],
): AgentRecord {
  const effective = effectiveGrantsOf(agent, groups)
  if (effective.grants === agent.grants) return agent
  return { ...agent, grants: effective.grants }
}
