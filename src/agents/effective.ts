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

/** The grant fields that hold a pattern list. */
type PatternField = 'tools' | 'resources' | 'prompts'

const OPTIONAL_FIELDS: readonly PatternField[] = ['resources', 'prompts']

function compareAsText(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

/**
 * Union of one field across contributing grants: `'*'` absorbs, otherwise a
 * sorted, deduplicated copy. `undefined` means "no group declared this field",
 * which the caller turns into an ABSENT key rather than an empty list.
 */
function unionField(
  grants: readonly AgentGrant[],
  field: PatternField,
): readonly string[] | '*' | undefined {
  const names = new Set<string>()
  let isDeclared = false
  for (const grant of grants) {
    const value = grant[field]
    if (value === undefined) continue
    isDeclared = true
    if (value === '*') return '*'
    for (const pattern of value) names.add(pattern)
  }
  if (!isDeclared) return undefined
  return [...names].sort(compareAsText)
}

/** One merged grant from every group grant for the same server. */
function mergeGrants(grants: readonly AgentGrant[]): AgentGrant {
  const tools = unionField(grants, 'tools')
  const merged: Record<string, unknown> = { tools: tools ?? [] }
  for (const field of OPTIONAL_FIELDS) {
    const value = unionField(grants, field)
    if (value !== undefined) merged[field] = value
  }
  return merged as AgentGrant
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
