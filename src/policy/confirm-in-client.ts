import { CONFIRM_ANY_AGENT } from './constants.js'
import type { Policy } from './schema.js'

/**
 * True when the policy makes the person at the client confirm this tool call
 * (`servers.<name>.confirmInClient`, ADR-0019): ANY entry that covers the
 * tool — the exact name, or any trailing-`*` prefix of it — names this agent
 * or `"*"`. Unlike the admin's `tools` outcome, entries add up instead of the
 * most specific one winning: this is a stop rule, and an exact entry must
 * never quietly lift the confirmation a pattern asks for (security review
 * 2026-10-02). `agentName` is absent on the local `wrap` path, which only
 * `"*"` covers: there is no authenticated name to compare.
 *
 * Independent of the admin's outcome for the tool: this says whether a
 * confirmation is required, never whether one replaces an admin.
 */
export function isConfirmInClient(
  policy: Policy,
  serverName: string,
  toolName: string,
  agentName: string | undefined,
): boolean {
  const servers = policy.servers
  if (servers === undefined || !Object.hasOwn(servers, serverName)) return false
  const entries = servers[serverName]?.confirmInClient
  if (entries === undefined) return false
  return Object.entries(entries).some(
    ([pattern, agents]) =>
      coversTool(pattern, toolName) &&
      (agents.includes(CONFIRM_ANY_AGENT) || (agentName !== undefined && agents.includes(agentName))),
  )
}

/** The tool-rule key syntax: an exact name, or a single trailing `*` matching a prefix. */
function coversTool(pattern: string, toolName: string): boolean {
  return pattern.endsWith('*') ? toolName.startsWith(pattern.slice(0, -1)) : pattern === toolName
}
