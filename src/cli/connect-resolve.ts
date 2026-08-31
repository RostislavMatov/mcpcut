import type { EffectiveAgentReader } from '../agents/effective-reader.js'
import type { AgentRecord } from '../agents/schema.js'
import { formatReadableField } from '../journal/format.js'
import type { RegistryStore } from '../registry/store.js'
import type { ServerRecord } from '../registry/schema.js'
import {
  AGENT_TOKEN_ENV_VAR,
  MAX_LISTED_SERVERS,
  authFailureMessage,
  missingTokenMessage,
  noGrantMessage,
} from './connect-constants.js'

/**
 * Everything `connect` decides BEFORE a single byte moves: who the caller is,
 * whether it may have this server at all, and what the registry says the
 * server is.
 *
 * The order is the security order, and each step exists to keep the next one
 * from leaking:
 *  1. token present (env only — see `AGENT_TOKEN_ENV_VAR`);
 *  2. token resolves to a live agent (`findAgentByToken` already folds
 *     "revoked" into "no such token");
 *  3. that agent IS the one `--agent` names;
 *  4. that agent holds a grant for the requested server;
 *  5. only then is the registry consulted at all.
 *
 * Steps 2 and 3 answer with ONE indistinguishable message, so `connect` never
 * becomes an oracle for which tokens exist, which are still live, or whom
 * they belong to. Step 5 sits behind step 4 on purpose: an unknown-server
 * answer can therefore only be obtained by someone who already holds a grant
 * for that exact name, so no one can enumerate the registry through it. The
 * hint it prints is the intersection of the caller's OWN grants with the
 * registry — never the registry itself.
 */

/** Why a connection was refused before any traffic. Codes are for tests/callers, not operators. */
export type ConnectRefusalCode =
  | 'missing-token'
  | 'authentication-failed'
  | 'no-grant'
  | 'unknown-server'
  | 'store-error'

export interface ConnectRefusal {
  readonly code: ConnectRefusalCode
  /** Complete, newline-terminated operator message. Always stderr-bound. */
  readonly message: string
}

export type ResolveConnectResult =
  | { readonly status: 'resolved'; readonly agent: AgentRecord; readonly record: ServerRecord }
  | { readonly status: 'refused'; readonly refusal: ConnectRefusal }

export interface ResolveConnectArgs {
  /** Server name as typed on the command line (untrusted: sanitized before echoing). */
  readonly serverName: string
  /** Agent name as typed on the command line. */
  readonly agentName: string
  /** Environment to read the token from — never argv. */
  readonly env: NodeJS.ProcessEnv
  /**
   * The EFFECTIVE record source (`agents/effective-reader.ts`), never the bare
   * store: the two `Object.hasOwn(agent.grants, …)` reads below decide against
   * the matrix a group membership already expanded (G2).
   */
  readonly agents: Pick<EffectiveAgentReader, 'findAgentByToken'>
  readonly registry: Pick<RegistryStore, 'getServer' | 'listServers'>
}

function refuse(code: ConnectRefusalCode, message: string): ResolveConnectResult {
  return { status: 'refused', refusal: { code, message } }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Servers this agent was granted that actually exist in the registry, so a
 * mistyped name gets a useful hint without disclosing anything the caller was
 * not already granted. A registry read failure simply yields no hint.
 */
async function grantedRegisteredServers(
  agent: AgentRecord,
  registry: Pick<RegistryStore, 'listServers'>,
): Promise<readonly string[]> {
  try {
    const registered = await registry.listServers()
    return registered
      .map((record) => record.name)
      .filter((name) => Object.hasOwn(agent.grants, name))
      .slice(0, MAX_LISTED_SERVERS)
  } catch {
    return []
  }
}

function unknownServerMessage(serverName: string, granted: readonly string[]): string {
  const head = `unknown server "${serverName}"\n`
  if (granted.length === 0) {
    return head
  }
  return `${head}Servers granted to you and present in the registry: ${granted.join(', ')}\n`
}

/** Runs the pre-traffic checks in order; the first failure wins. */
export async function resolveConnectTarget(args: ResolveConnectArgs): Promise<ResolveConnectResult> {
  const serverName = formatReadableField(args.serverName)
  const agentName = formatReadableField(args.agentName)

  const token = args.env[AGENT_TOKEN_ENV_VAR]
  if (token === undefined || token.length === 0) {
    return refuse('missing-token', missingTokenMessage())
  }

  let agent: AgentRecord | undefined
  try {
    agent = await args.agents.findAgentByToken(token)
  } catch (error: unknown) {
    return refuse('store-error', `cannot read the agent store: ${describeError(error)}\n`)
  }

  // Unknown token, revoked token, and a live token belonging to some other
  // agent are ONE answer on purpose (see the module doc).
  if (agent === undefined || agent.name !== args.agentName) {
    return refuse('authentication-failed', authFailureMessage(agentName))
  }

  if (!Object.hasOwn(agent.grants, args.serverName)) {
    return refuse('no-grant', noGrantMessage(agentName, serverName))
  }

  let record: ServerRecord | undefined
  try {
    record = await args.registry.getServer(args.serverName)
  } catch (error: unknown) {
    return refuse('store-error', `cannot read the server registry: ${describeError(error)}\n`)
  }

  if (record === undefined) {
    const granted = await grantedRegisteredServers(agent, args.registry)
    return refuse('unknown-server', unknownServerMessage(serverName, granted))
  }

  return { status: 'resolved', agent, record }
}
