import { AGENT_TOKEN_ENV_VAR } from './connect-constants.js'

/**
 * Everything `mcpcut connect --url` says to a human (ADR-0015).
 *
 * Two rules govern every string here, both inherited from
 * `./connect-constants.ts`:
 *
 *  - **stdout is the protocol channel.** This command is what an agent's
 *    `.mcp.json` runs, so its stdout carries JSON-RPC and nothing else. Every
 *    line below goes to stderr, which is where MCP clients put their server
 *    logs.
 *  - each message is a function with a doc comment saying WHEN it is printed,
 *    and ends with its own `\n`.
 *
 * A third rule is this command's own: a message names the **origin** of the
 * service — `https://host:port` — and never the full endpoint. The path is
 * not secret (it holds an agent and a server name), but the HTTP client's own
 * hygiene rule is "status, method and host only", and one rule for the whole
 * command is easier to keep than two.
 */

/**
 * The prefix of every agent token, restated here rather than imported from
 * `agents/constants.ts`: that module reaches `src/config.ts`, and this
 * command must run on a machine whose install config does not exist. A test
 * pins the two equal, so the copy cannot drift.
 */
export const AGENT_TOKEN_MARKER = 'mcpj_'

/** The flag that takes back the plain-http refusal of PE8. */
export const ALLOW_HTTP_FLAG = '--allow-http'

export const BRIDGE_USAGE = `Usage:
  mcpcut connect --url <address> [${ALLOW_HTTP_FLAG}]
                                         Bridge this machine's stdio to a remote mcpcut service.
                                         The address is the service's base URL, or the full
                                         /agents/<agent>/servers/<server> address of one pair.
                                         The agent token comes from ${AGENT_TOKEN_ENV_VAR};
                                         no setup, no data directory, no registry is read here.
`

/**
 * Anything that looks like a token, or any flag that would carry one, was
 * found in argv. Printed BEFORE the arguments are parsed and before anything
 * is dialed — and deliberately without echoing the offending argument, which
 * is the one thing that must not reach a log.
 */
export function tokenInArgvMessage(): string {
  return (
    `refusing: the agent token must not appear in the command line. Every process on this ` +
    `machine can read another's argv through \`ps\`.\n` +
    `Put it in the environment instead — ${AGENT_TOKEN_ENV_VAR} — which is what an MCP client's ` +
    `"env" block in .mcp.json is for.\n`
  )
}

/**
 * `--url` was combined with the local form's arguments (a server name,
 * `--agent`). The two modes are different commands wearing one name: one
 * reads this machine's registry, the other reads nothing at all.
 */
export function mixedModeMessage(): string {
  return (
    `refusing: --url is the REMOTE form of connect and takes no server name and no --agent — ` +
    `the service on the other end resolves both from the address and the token.\n\n` +
    BRIDGE_USAGE
  )
}

/**
 * The address is plain `http` to a host other than this machine, and
 * `--allow-http` was not given (owner decision PE8). Unlike the console's
 * `--remote`, which warns, this refuses: the agent token crosses that network
 * on every single request, with nobody watching.
 */
export function plainHttpRefusedMessage(origin: string): string {
  return (
    `refusing ${origin}: plain http to another host would put ${AGENT_TOKEN_ENV_VAR} on the ` +
    `network in clear, on every request.\n` +
    `Use https://, or tunnel it: ssh -L <port>:127.0.0.1:<port> <user>@<host>.\n` +
    `If that network really is trusted, say so explicitly with ${ALLOW_HTTP_FLAG}.\n`
  )
}

/** `--allow-http` was given for such an address: the operator's call, said out loud once. */
export function plainHttpWarning(origin: string): string {
  return (
    `warning: ${origin} is plain http to a non-loopback host — the agent token crosses that ` +
    `network in clear on every request (${ALLOW_HTTP_FLAG}).\n`
  )
}

/**
 * The service answered 401. One string for every cause, exactly as the
 * service itself refuses without distinguishing them: telling a revoked token
 * from an unknown one would make this command an oracle.
 */
export function unauthorizedMessage(origin: string): string {
  return (
    `the service at ${origin} did not accept the agent token: it may have been revoked, ` +
    `mistyped, or issued by a different service.\n`
  )
}

/**
 * The service answered 403 — its Host or Origin screening refused us before
 * it ever looked at the token. That is the service's configuration, not this
 * machine's, so the fix is named on the service's side.
 */
export function forbiddenMessage(origin: string): string {
  return (
    `the service at ${origin} refused the request before reading the token (HTTP 403): the ` +
    `address this bridge dials is not one it answers to.\n` +
    `On the service, name it: mcpcut setup --serve-public-url <the address agents use>.\n`
  )
}

/**
 * The service answered 404 on the very first request. What that means depends
 * on which kind of address was given, and the front deliberately does not
 * distinguish the cases for us, so neither does this.
 */
export function noEndpointMessage(origin: string, isPoolAddress: boolean): string {
  if (isPoolAddress) {
    return (
      `the service at ${origin} serves no agent pool endpoint (HTTP 404). A service older than ` +
      `the pool exposes one address per pair — give the full address instead: ` +
      `${origin}/agents/<agent>/servers/<server>.\n`
    )
  }
  return (
    `the service at ${origin} has nothing at that address for this token (HTTP 404): check the ` +
    `agent and server names in it, and that this token belongs to that agent.\n`
  )
}

/**
 * The service forgot the session mid-conversation. Exit code 4 rather than 1:
 * the invocation was fine and a fresh bridge would work, which is what an MCP
 * client does when its server process exits.
 */
export function sessionExpiredMessage(origin: string): string {
  return (
    `the service at ${origin} no longer knows this session. Reconnect the MCP server in your ` +
    `client to start a new one.\n`
  )
}

/** The server-initiated stream did not come back within the client's reconnect budget. */
export function streamLostMessage(origin: string): string {
  return (
    `lost the event stream from ${origin} and could not re-establish it. Reconnect the MCP ` +
    `server in your client to start a new one.\n`
  )
}
