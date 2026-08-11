import { matchToolRule } from '../policy/match.js'
import type { AgentMethodGrants } from './method-grants.js'
import { resourceUriMatcher } from './resource-match.js'
import type { AgentRecord } from './schema.js'

export type { AgentMethodGrants } from './method-grants.js'

/**
 * Pure derivation of what one agent may see and call on one server.
 *
 * Precedence lives in the plan: no grant → the tool is invisible in
 * `tools/list` AND denied on call, before the M2 policy chain even runs; a
 * grant only OPENS the gate — policy (`decide()`) still applies afterwards.
 *
 * Pattern semantics are policy's, by construction: an array grant is turned
 * into a rule map and matched with `policy/match.ts`'s `matchToolRule`
 * (exact name wins, else longest trailing-`*` prefix), so grants and policy
 * rules can never drift apart. The M4 method-grant dimension (`resources`/
 * `prompts` fields, `methodGrants` below) keeps that matcher for PROMPT
 * NAMES, but resource URIs go through `resource-match.ts` instead: same
 * "exact or trailing-`*`" surface syntax, but matched on NORMALIZED URIs
 * with segment-boundary prefixes, because a lexical prefix over a URI is
 * traversable (`..`, percent-encoding — see that module's header).
 */
export interface AgentScope {
  /** True iff the agent's grant for this server covers `tool`. */
  isGranted(tool: string): boolean
  /** The subset of `tools` the agent may see, input order preserved. */
  filterVisible(tools: readonly string[]): string[]
  /**
   * The non-tool-method dimension (M4 Task 6). Derived from the same grant:
   * absent `resources`/`prompts` fields — and an EMPTY array, which grants
   * nothing — report no grant presence, which the gate maps to the exact M3
   * fail-closed denial.
   */
  readonly methodGrants: AgentMethodGrants
}

/** Internal shape of a resolved grant: everything, nothing, or a rule map. */
type GrantRules = 'all' | 'none' | Readonly<Record<string, true>>

/** The grant fields that resolve into pattern rule maps. */
type PatternField = 'tools' | 'resources' | 'prompts'

function resolveGrantRules(agent: AgentRecord, server: string, field: PatternField): GrantRules {
  if (agent.revokedAt !== undefined) return 'none'
  const grant = Object.hasOwn(agent.grants, server) ? agent.grants[server] : undefined
  const patterns = grant?.[field]
  if (patterns === undefined) return 'none'
  if (patterns === '*') return 'all'
  // An empty array is equivalent to an absent field: zero grants, and — for
  // the method dimension — no "grant presence" to open completion/complete.
  if (patterns.length === 0) return 'none'
  // Object.fromEntries defines own properties (never invokes setters), so
  // even a hostile pattern name cannot touch the prototype chain.
  return Object.fromEntries(patterns.map((pattern) => [pattern, true as const]))
}

/** Membership predicate over one resolved rule set, shared by all three fields. */
function grantedBy(rules: GrantRules): (subject: string) => boolean {
  if (rules === 'all') return () => true
  if (rules === 'none') return () => false
  return (subject) => matchToolRule(rules, subject) !== null
}

/**
 * Membership predicate for the resources dimension: normalized URI matching,
 * fail-closed on unparseable URIs. `'all'` is total by declaration and skips
 * parsing — with everything granted there is no prefix boundary to bypass,
 * and denying odd-but-real resource ids under `'*'` would only break servers.
 */
function resourceGrantedBy(rules: GrantRules): (uri: string) => boolean {
  if (rules === 'all') return () => true
  if (rules === 'none') return () => false
  return resourceUriMatcher(Object.keys(rules))
}

/** Builds the scope for `(agent, server)`. A revoked agent has nothing granted. */
export function agentScope(agent: AgentRecord, server: string): AgentScope {
  const isGranted = grantedBy(resolveGrantRules(agent, server, 'tools'))
  const resourceRules = resolveGrantRules(agent, server, 'resources')
  const promptRules = resolveGrantRules(agent, server, 'prompts')

  return {
    isGranted,
    filterVisible: (tools) => tools.filter(isGranted),
    methodGrants: {
      isResourceGranted: resourceGrantedBy(resourceRules),
      isPromptGranted: grantedBy(promptRules),
      hasResourcesGrant: () => resourceRules !== 'none',
      hasPromptsGrant: () => promptRules !== 'none',
    },
  }
}
