import { PRODUCT_VERSION } from '../brand.js'
import { BRIDGE_POOL_PATH } from '../bridge/constants.js'
import { checkBridgeScheme, parseBridgeUrl } from '../bridge/url.js'
import { ALLOW_HTTP_FLAG } from '../cli/connect-bridge-messages.js'
import { AGENT_TOKEN_ENV_VAR } from '../cli/connect-constants.js'
import { CLI_NAME } from '../setup/constants.js'

/**
 * The client config block an owner pastes into an agent's MCP client
 * (ADR-0015, PRD phase 4). One pure function, no IO: the CLI prints it, the
 * web page renders it, and the console shows the CLI's stdout — so the block
 * is the same bytes on every surface for the same address and token.
 *
 * It lives in `src/agents/` because both `src/cli/**` and `src/ui/**` call it,
 * and the plane shows this block but never writes a client's file (ADR-0015).
 */

/** The one key the block carries — one agent, one pool, one entry (PRD Decisions Log). */
export const CLIENT_CONFIG_ENTRY_NAME = 'mcpcut'

/** Stands in for the token wherever the real one is not on screen (`agent config`, `/agents`). */
export const TOKEN_PLACEHOLDER = '<token>'

/** `stdio` goes through the `connect --url` bridge; `http` is for clients that speak HTTP natively. */
export type ClientConfigForm = 'stdio' | 'http'

/** How the client starts the bridge: the installed binary, or `npx` of the published package. */
export type ClientConfigLauncher = 'binary' | 'npx'

/**
 * PE10 fulfilled in phase 6: the package is on npm, so the block needs nothing
 * installed on the agent's machine but Node 24+. `'binary'` stays for an owner
 * who installs mcpcut there.
 */
export const CLIENT_CONFIG_LAUNCHER: ClientConfigLauncher = 'npx'

export const NPX_COMMAND = 'npx'

/** Lets `npx` install without a prompt the client could never answer. */
const NPX_YES_FLAG = '-y'

/** Spaces, not TAB: the console pane renders a TAB as `?`. */
const JSON_INDENT = 2

const BRIDGE_ARGV = ['connect', '--url'] as const

const AUTHORIZATION_HEADER = 'Authorization'

export interface ClientConfigInput {
  /** An origin, or `SERVE_URL_PLACEHOLDER` when the address is not known. */
  readonly serveUrl: string
  /** The real token, or `TOKEN_PLACEHOLDER`. */
  readonly token: string
  readonly form: ClientConfigForm
  /** Defaults to `CLIENT_CONFIG_LAUNCHER`. */
  readonly launcher?: ClientConfigLauncher
  /** Pinned into the npx form (PE9); defaults to `PRODUCT_VERSION`. */
  readonly version?: string
}

export interface StdioClientEntry {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export interface HttpClientEntry {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

export interface ClientConfigDocument {
  readonly mcpServers: Readonly<Record<typeof CLIENT_CONFIG_ENTRY_NAME, StdioClientEntry | HttpClientEntry>>
}

/**
 * PE8, decided by the bridge's own verdict so the two can never disagree: the
 * flag is in the block exactly when the bridge would refuse the address
 * without it. An address the bridge cannot parse (the placeholder) needs none.
 */
export function needsAllowHttp(serveUrl: string): boolean {
  const parsed = parseBridgeUrl(serveUrl)
  return parsed.ok && checkBridgeScheme(parsed.url, false) === 'refuse'
}

function stdioEntryOf(input: ClientConfigInput): StdioClientEntry {
  const bridgeArgs = [
    ...BRIDGE_ARGV,
    input.serveUrl,
    ...(needsAllowHttp(input.serveUrl) ? [ALLOW_HTTP_FLAG] : []),
  ]
  const launcher = input.launcher ?? CLIENT_CONFIG_LAUNCHER
  const env = { [AGENT_TOKEN_ENV_VAR]: input.token }
  if (launcher === 'npx') {
    const version = input.version ?? PRODUCT_VERSION
    return { command: NPX_COMMAND, args: [NPX_YES_FLAG, `${CLI_NAME}@${version}`, ...bridgeArgs], env }
  }
  return { command: CLI_NAME, args: bridgeArgs, env }
}

/**
 * No bridge: the client dials the pool path itself (PE5 appends it for the
 * bridge; here nobody would), with the token as the one credential the front
 * accepts — `Authorization: Bearer <token>`.
 */
function httpEntryOf(input: ClientConfigInput): HttpClientEntry {
  return {
    url: `${input.serveUrl}${BRIDGE_POOL_PATH}`,
    headers: { [AUTHORIZATION_HEADER]: `Bearer ${input.token}` },
  }
}

/** The block as a value — a new document on every call. */
export function clientConfigOf(input: ClientConfigInput): ClientConfigDocument {
  const entry = input.form === 'http' ? httpEntryOf(input) : stdioEntryOf(input)
  return { mcpServers: { [CLIENT_CONFIG_ENTRY_NAME]: entry } }
}

/** Pretty JSON, 2-space indent, one trailing newline — what a client's file looks like. */
export function renderClientConfig(input: ClientConfigInput): string {
  return `${JSON.stringify(clientConfigOf(input), null, JSON_INDENT)}\n`
}
