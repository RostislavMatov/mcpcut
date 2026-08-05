import { matchToolRule } from '../policy/match.js'
import type { AgentRecord } from './schema.js'

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
 * rules can never drift apart.
 */
export interface AgentScope {
  /** True iff the agent's grant for this server covers `tool`. */
  isGranted(tool: string): boolean
  /** The subset of `tools` the agent may see, input order preserved. */
  filterVisible(tools: readonly string[]): string[]
}

/** Internal shape of a resolved grant: everything, nothing, or a rule map. */
type GrantRules = 'all' | 'none' | Readonly<Record<string, true>>

function resolveGrantRules(agent: AgentRecord, server: string): GrantRules {
  if (agent.revokedAt !== undefined) return 'none'
  const grant = Object.hasOwn(agent.grants, server) ? agent.grants[server] : undefined
  if (grant === undefined) return 'none'
  if (grant.tools === '*') return 'all'
  // Object.fromEntries defines own properties (never invokes setters), so
  // even a hostile pattern name cannot touch the prototype chain.
  return Object.fromEntries(grant.tools.map((pattern) => [pattern, true as const]))
}

/** Builds the scope for `(agent, server)`. A revoked agent has nothing granted. */
export function agentScope(agent: AgentRecord, server: string): AgentScope {
  const rules = resolveGrantRules(agent, server)

  function isGranted(tool: string): boolean {
    if (rules === 'all') return true
    if (rules === 'none') return false
    return matchToolRule(rules, tool) !== null
  }

  return {
    isGranted,
    filterVisible: (tools) => tools.filter(isGranted),
  }
}
