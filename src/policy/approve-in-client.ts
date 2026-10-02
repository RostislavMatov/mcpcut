import { matchToolRule } from './match.js'
import type { Policy } from './schema.js'

/**
 * True when the policy lets the person at the client approve this held tool
 * in the session, whoever they are (`servers.<name>.approveInClient`,
 * ADR-0019): the admin named the tool, so no admin token is needed for it and
 * the agent's own user may answer. Names match as tool rules do — exact, or
 * the longest trailing-`*` prefix.
 */
export function isApprovableInClient(policy: Policy, serverName: string, toolName: string): boolean {
  const servers = policy.servers
  if (servers === undefined || !Object.hasOwn(servers, serverName)) return false
  const listed = servers[serverName]?.approveInClient ?? []
  if (listed.length === 0) return false
  return matchToolRule(Object.fromEntries(listed.map((pattern) => [pattern, true])), toolName) !== null
}
