import { join } from 'node:path'
import { POLICY_ENV_VAR, POLICY_FILE_NAME } from '../policy/constants.js'
import { DIAGNOSTIC_PREFIX } from '../upstream/constants.js'

/**
 * Constants and operator-facing messages for `mcp-journal connect` (M3
 * Task 12). Per-area constants rule (`src/policy/constants.ts` precedent):
 * these are connect's own and do not belong in `src/config.ts`.
 *
 * One rule governs every string in this file: **stdout is the protocol
 * channel**. `connect` is what an agent's `.mcp.json` runs, so its stdout
 * carries JSON-RPC and nothing else — every message here is written to
 * stderr.
 */

/**
 * The ONLY place `connect` accepts an agent token from. Never a flag: argv is
 * world-readable through `ps`, an environment block is not (and the agent's
 * client config sets it per server anyway).
 */
export const AGENT_TOKEN_ENV_VAR = 'MCP_AGENT_TOKEN'

/**
 * Where the "no translation between session models" decision is recorded.
 * `cli/serve-constants.ts` declares the same path for the `serve` side; the
 * two are deliberately independent (parallel Wave 4 tasks own one file each)
 * and should be hoisted into one shared constant when both have landed.
 */
export const ADR_0002_REFERENCE = 'docs/adr/0002-http-dual-version.md'

/**
 * Diagnostic prefix and child-exit grace period moved to
 * `src/upstream/constants.ts` with the upstream extraction (M5.5, probe
 * engine); re-exported so existing importers keep working.
 */
export { CHILD_EXIT_GRACE_MS, DIAGNOSTIC_PREFIX } from '../upstream/constants.js'

/** Exit code for any refusal decided before (or instead of) a session. */
export const EXIT_CODE_REFUSED = 1

/**
 * Max server names listed in the `unknown server` hint, so a mistyped name
 * cannot turn into an unbounded dump for an agent with many grants.
 */
export const MAX_LISTED_SERVERS = 20

/** Where a connect session's policy — and only a connect session's policy — comes from. */
export const POLICY_SOURCE_DESCRIPTION = `<journal-dir>/${POLICY_FILE_NAME}`

export const CONNECT_USAGE = `Usage:
  mcp-journal connect <server> --agent <name> [--fail-closed]
                                         Bridge a registered MCP server to this agent,
                                         enforcing its grants and journaling all traffic.
                                         The agent token comes from ${AGENT_TOKEN_ENV_VAR};
                                         the policy comes from ${POLICY_SOURCE_DESCRIPTION} only
                                         (no --policy, no $${POLICY_ENV_VAR}).
`

/**
 * `--policy` on `connect` is a refusal, not an option: this command is
 * launched by the agent's own client config, so argv is the untrusted side of
 * the boundary and a policy chosen there would let the agent pick the rules it
 * is judged by. The flag stays *recognized* only so this explanation can be
 * printed instead of bare usage text.
 */
export function policyFlagRefusal(journalDir: string): string {
  return (
    'refusing --policy: connect is started by the agent\'s own client config, so a policy path ' +
    'given on the command line would be chosen by the party the policy constrains.\n' +
    `Put the policy in the plane's own directory instead: ${join(journalDir, POLICY_FILE_NAME)}\n`
  )
}

/**
 * One line per agent-controlled policy source that exists and was ignored, so
 * an operator who set one is never left wondering why it had no effect.
 */
export function policySourceIgnoredNote(source: string, journalDir: string): string {
  return (
    `${DIAGNOSTIC_PREFIX} ignoring ${source}: connect reads its policy only from ` +
    `${join(journalDir, POLICY_FILE_NAME)}\n`
  )
}

/**
 * The single answer to every authentication failure: unknown token, revoked
 * token, and a valid token belonging to a DIFFERENT agent all produce this
 * exact string. Telling them apart would turn `connect` into an oracle for
 * which tokens exist and which agents are still live.
 */
export function authFailureMessage(requestedAgent: string): string {
  return (
    `authentication failed: ${AGENT_TOKEN_ENV_VAR} is not a valid token for agent ` +
    `"${requestedAgent}"\n`
  )
}

/** `--agent` was given but the environment holds no token at all. */
export function missingTokenMessage(): string {
  return (
    `${AGENT_TOKEN_ENV_VAR} is not set: connect reads the agent token from the environment ` +
    'only, never from argv (which is visible to every process via `ps`).\n'
  )
}

/** The agent authenticated, but its grant matrix has no entry for this server. */
export function noGrantMessage(agentName: string, serverName: string): string {
  return (
    `agent "${agentName}" has no grant for server "${serverName}".\n` +
    `Grant it with: mcp-journal agent grant ${agentName} ${serverName} --tools "<patterns>"\n`
  )
}

/**
 * Refusal for a `protocol: 'stateless'` upstream whose client opened with an
 * `initialize` handshake: the pair speaks two different session models and
 * the control plane deliberately does not translate between them (ADR-0002).
 */
export function statelessInitializeRefusal(serverName: string): string {
  return (
    `protocol-mismatch: this client opened a sessionful MCP session (initialize) but server ` +
    `"${serverName}" is registered as stateless (2026-07-28); the control plane does not ` +
    `translate between session models — see ${ADR_0002_REFERENCE}\n`
  )
}
