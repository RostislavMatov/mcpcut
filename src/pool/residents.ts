import type { AgentRecord } from '../agents/schema.js'
import type { ServerRecord } from '../registry/schema.js'

/**
 * Which (agent, stdio server) pairs the plane keeps running between pool
 * sessions (ADR-0016, RS2) — pure, so the rule can be read and tested in one
 * place, and the supervisor that acts on it stays about processes.
 *
 * A pair is resident when all of these hold at once: the agent is not
 * revoked; its EFFECTIVE grants (personal and group, already materialized by
 * the caller) name the server; the server is registered as `stdio`. HTTP is
 * never held — it reconnects with one request, and holding someone else's
 * remote session open is a risk of its own (owner decision D5).
 *
 * Order is by agent name, then server name, by code units (never
 * `localeCompare`): the first `cap` are residents, the rest start on demand.
 */

export interface ResidentPair {
  readonly agentName: string
  /**
   * The agent record's `createdAt`. Part of the key: an agent deleted and
   * created again under the same name is a different agent, and must never
   * be handed the old one's process (RS3).
   */
  readonly agentCreatedAt: string
  readonly serverName: string
}

export interface DesiredResidents {
  readonly resident: readonly ResidentPair[]
  /** Granted stdio pairs past the cap: started on demand, kept warm (RS8). */
  readonly overCap: readonly ResidentPair[]
}

export function desiredResidentPairs(
  agents: readonly AgentRecord[],
  servers: readonly ServerRecord[],
  cap: number,
): DesiredResidents {
  const stdioServers = new Set(servers.filter((server) => server.transport === 'stdio').map((server) => server.name))
  const pairs = agents
    .filter((agent) => agent.revokedAt === undefined)
    .flatMap((agent) =>
      Object.keys(agent.grants)
        .filter((server) => Object.hasOwn(agent.grants, server) && stdioServers.has(server))
        .map((serverName) => ({ agentName: agent.name, agentCreatedAt: agent.createdAt, serverName })),
    )
    .sort(comparePairs)
  const limit = Math.max(0, cap)
  return { resident: pairs.slice(0, limit), overCap: pairs.slice(limit) }
}

/**
 * The supervisor's key for a pair. The parts are joined with NUL, which no
 * agent name, timestamp or server name can hold. Written as an escape: a
 * literal invisible character makes a file "binary" to git (the lesson of
 * `safeNameOf`).
 */
export function residentKeyOf(pair: ResidentPair): string {
  return `${pair.agentName}\u0000${pair.agentCreatedAt}\u0000${pair.serverName}`
}

function comparePairs(left: ResidentPair, right: ResidentPair): number {
  return compareCodeUnits(left.agentName, right.agentName) || compareCodeUnits(left.serverName, right.serverName)
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}
