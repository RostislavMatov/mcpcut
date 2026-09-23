import { parseArgs } from 'node:util'
import { renderClientConfig, TOKEN_PLACEHOLDER, type ClientConfigForm } from '../agents/client-config.js'
import { AgentNotFoundError, type AgentsStore } from '../agents/store.js'
import { formatReadableField } from '../journal/format.js'
import { CLI_NAME } from '../setup/constants.js'
import {
  addressNoteOf,
  resolveServeAddress,
  type ServeAddress,
  type ServeAddressSourceOptions,
} from '../setup/serve-address.js'

/**
 * The client config block on the CLI (ADR-0015, PRD phase 4): printed by
 * `agent create` beside the one-time token, and again — with `<token>` — by
 * `agent config <name> [--http]`. Everything here goes to STDOUT: in the
 * console stderr lands under a `— stderr —` rule, off the first screen of the
 * pane that holds the token.
 *
 * The address is the serve address of the install THIS process runs in: in
 * the remote console that is the server's config, which is right — the block
 * says where the agent dials, not where the administrator connected from.
 */

export const CLIENT_CONFIG_HEADING = "Client config — paste into the agent's client (the token is inside):"

export const CLIENT_CONFIG_PLACEHOLDER_NOTE = `Replace ${TOKEN_PLACEHOLDER} with the token \`agent create\` printed.`

/** `agent config`'s one flag: the native HTTP form instead of the bridge. */
export const HTTP_FLAG = '--http'

export const AGENT_CONFIG_USAGE = `Usage: ${CLI_NAME} agent config <name> [${HTTP_FLAG}]\n`

interface Writable {
  write(chunk: string): unknown
}

interface ConfigIo {
  readonly stdout: Writable
  readonly stderr: Writable
}

export interface ClientConfigView {
  readonly agentName: string
  /** The real token, or `TOKEN_PLACEHOLDER`. */
  readonly token: string
  readonly form: ClientConfigForm
  readonly address: ServeAddress
}

function httpFormHint(agentName: string): string {
  return `HTTP client instead? ${CLI_NAME} agent config ${formatReadableField(agentName)} ${HTTP_FLAG}`
}

/**
 * Prints one block with what surrounds it. The agent name is sanitized only
 * in the hint lines; inside the JSON the token and address go through
 * `JSON.stringify`, which escapes anything a terminal could mistake.
 */
export function writeClientConfig(io: ConfigIo, view: ClientConfigView): void {
  const isPlaceholder = view.token === TOKEN_PLACEHOLDER
  io.stdout.write('\n')
  if (!isPlaceholder) io.stdout.write(`${CLIENT_CONFIG_HEADING}\n`)
  io.stdout.write(renderClientConfig({ serveUrl: view.address.url, token: view.token, form: view.form }))
  if (isPlaceholder) io.stdout.write(`${CLIENT_CONFIG_PLACEHOLDER_NOTE}\n`)
  else if (view.form === 'stdio') io.stdout.write(`${httpFormHint(view.agentName)}\n`)
  const note = addressNoteOf(view.address)
  if (note !== undefined) io.stdout.write(`${note}\n`)
}

function parseConfigArgs(args: readonly string[]): { name: string; form: ClientConfigForm } | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: { http: { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    })
    const [name] = positionals
    if (name === undefined || positionals.length !== 1) return undefined
    return { name, form: values.http === true ? 'http' : 'stdio' }
  } catch {
    return undefined
  }
}

/**
 * `agent config <name> [--http]`. No admin token (C3): the block without the
 * token is not a secret. A revoked agent still gets its block — refusing it
 * would protect nothing — with a note on stderr.
 */
export async function runConfig(
  args: readonly string[],
  io: ConfigIo,
  opts: ServeAddressSourceOptions,
  store: Pick<AgentsStore, 'getAgent'>,
): Promise<number> {
  const parsed = parseConfigArgs(args)
  if (parsed === undefined) {
    io.stderr.write(AGENT_CONFIG_USAGE)
    return 1
  }
  const agent = await store.getAgent(parsed.name)
  if (agent === undefined) throw new AgentNotFoundError(parsed.name)
  if (agent.revokedAt !== undefined) {
    io.stderr.write(
      `note: agent "${formatReadableField(agent.name)}" is revoked — its token no longer opens a session\n`,
    )
  }
  writeClientConfig(io, {
    agentName: agent.name,
    token: TOKEN_PLACEHOLDER,
    form: parsed.form,
    address: resolveServeAddress(opts),
  })
  return 0
}
