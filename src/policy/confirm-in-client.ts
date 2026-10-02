import { CONFIRM_ANY_AGENT } from './constants.js'
import { matchToolRule } from './match.js'
import type { Policy } from './schema.js'

/**
 * True when the policy makes the person at the client confirm this tool call
 * (`servers.<name>.confirmInClient`, ADR-0019): the tool's entry — exact, or
 * the longest trailing-`*` prefix, as tool rules match — names this agent or
 * `"*"`. `agentName` is absent on the local `wrap` path, which only `"*"`
 * covers: there is no authenticated name to compare.
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
  const match = matchToolRule(servers[serverName]?.confirmInClient, toolName)
  if (match === null) return false
  return match.value.includes(CONFIRM_ANY_AGENT) || (agentName !== undefined && match.value.includes(agentName))
}
