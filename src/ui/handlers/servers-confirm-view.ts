import { effectiveGrantsOf } from '../../agents/effective.js'
import type { InventoryStoreData } from '../../policy/inventory-store.js'
import type { AgentDirectory } from '../pages/servers-confirm-rule.js'
import type { ServersHandlersDeps } from './servers.js'

/**
 * What the Servers page needs beyond the registry for the client rule
 * (ADR-0019): who can be asked to confirm, and which inventory servers are
 * not registered. Read-only helpers of `handlers/servers.ts`.
 */

export type AgentDirectoryResult =
  | { readonly status: 'read'; readonly directory: AgentDirectory }
  /** The agents or groups store could not be read; the page offers off / all only. */
  | { readonly status: 'unavailable' }

/**
 * Who can be asked to confirm: every non-revoked agent, and per server the
 * agents whose EFFECTIVE grants (personal, else the groups') name it — the
 * same reading the gate authorizes with. Sorted by name for a stable page.
 * A failing store must not fail the whole Servers page — the registry and
 * the rules are still worth showing — so it degrades, saying why on the
 * diagnostics sink.
 */
export async function agentDirectoryOf(
  deps: Pick<ServersHandlersDeps, 'agents' | 'groups' | 'diagnostics'>,
): Promise<AgentDirectoryResult> {
  try {
    const [agents, groups] = await Promise.all([deps.agents.listAgents(), deps.groups.listGroups()])
    const live = agents
      .filter((agent) => agent.revokedAt === undefined)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const grantedBy = new Map<string, string[]>()
    for (const agent of live) {
      for (const serverName of Object.keys(effectiveGrantsOf(agent, groups).grants)) {
        grantedBy.set(serverName, [...(grantedBy.get(serverName) ?? []), agent.name])
      }
    }
    return { status: 'read', directory: { known: live.map((agent) => agent.name), grantedBy } }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    deps.diagnostics?.(`[servers] the agent list could not be read for the client rule: ${reason}\n`)
    return { status: 'unavailable' }
  }
}

/**
 * Inventory servers that are not in the registry, sorted: what ran under
 * `wrap` here — or a registered server since removed (removal does not prune
 * the inventory), which is why the page words it as "seen", not "running".
 */
export function wrapServerNamesOf(inventory: InventoryStoreData, registered: readonly string[]): readonly string[] {
  const known = new Set(registered)
  return Object.keys(inventory.servers).filter((name) => !known.has(name)).sort()
}
