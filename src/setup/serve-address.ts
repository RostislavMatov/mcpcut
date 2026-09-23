import { InvalidBindEnvError, resolveServeDefaults, type ServeServiceDefaults } from './bind.js'
import { CLI_NAME, SERVE_PORT_ENV_VAR } from './constants.js'
import { loadInstallConfigSync, type InstallConfigLoad } from './load.js'

/**
 * The address `agent create` and `agent config` write into a client config
 * as `--url` (ADR-0015, phase 4, C2). Pure: the caller loads the install
 * config and hands over the environment.
 */

/** Where the address came from — anything but `config` earns a note beside the block. */
export type ServeAddressSource = 'config' | 'derived' | 'unknown'

export interface ServeAddress {
  readonly url: string
  readonly source: ServeAddressSource
}

/** The placeholder the operator has to replace by hand — never a guess that looks real. */
export const SERVE_URL_PLACEHOLDER = '<serve-url>'

/** A derived address always dials loopback: it is only right on this machine. */
const DERIVED_LOOPBACK_HOST = '127.0.0.1'

/** `0` asks the kernel for any free port — nobody can dial it ahead of time. */
const ANY_FREE_PORT = 0

/**
 * `serve.publicUrl` when the install names one; otherwise the loopback form
 * of the bind: on the machine the plane runs on — the first-run case of the
 * owner's frame (19.09) — that address is right and needs no `--allow-http`.
 */
export function serveAddressOf(defaults: Pick<ServeServiceDefaults, 'port' | 'publicUrl'>): ServeAddress {
  if (defaults.publicUrl !== undefined) return { url: defaults.publicUrl, source: 'config' }
  if (defaults.port === ANY_FREE_PORT) return { url: SERVE_URL_PLACEHOLDER, source: 'unknown' }
  return { url: `http://${DERIVED_LOOPBACK_HOST}:${defaults.port}`, source: 'derived' }
}

/**
 * The same, from the environment and a loaded install config. An unusable
 * `MCPCUT_SERVE_PORT` means "unknown" here rather than a refusal: printing a
 * client config is not starting `serve`, and `ui` must not fail to start over
 * the other service's variable.
 */
export function serveAddressFromInstall(env: NodeJS.ProcessEnv, load: InstallConfigLoad): ServeAddress {
  try {
    return serveAddressOf(resolveServeDefaults(env, load))
  } catch (error: unknown) {
    if (error instanceof InvalidBindEnvError) return { url: SERVE_URL_PLACEHOLDER, source: 'unknown' }
    throw error
  }
}

/** Where `resolveServeAddress` reads from; both default to the process's own. */
export interface ServeAddressSourceOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly install?: InstallConfigLoad
}

/**
 * The serve address of the install THIS process runs in — what `agent create`
 * and the web's agent pages both put into a client config. In the remote
 * console the command runs in the server's `ui` daemon, so this is the
 * server's address: the block says where the agent dials, not where the
 * administrator connected from.
 */
export function resolveServeAddress(opts: ServeAddressSourceOptions = {}): ServeAddress {
  const env = opts.env ?? process.env
  return serveAddressFromInstall(env, opts.install ?? loadInstallConfigSync({ env }))
}

const SET_PUBLIC_URL_HINT = `${CLI_NAME} setup --serve-public-url <url>`

const DERIVED_ADDRESS_NOTE =
  `note: address derived from the serve bind; for agents on other machines run: ${SET_PUBLIC_URL_HINT}`

const UNKNOWN_ADDRESS_NOTE =
  `note: the serve address is not known (port 0 or an unusable ${SERVE_PORT_ENV_VAR}): ` +
  `replace ${SERVE_URL_PLACEHOLDER}, or run: ${SET_PUBLIC_URL_HINT}`

/**
 * The line beside a block whose address did not come from `serve.publicUrl`
 * — the same words on the CLI and on the web page. `undefined` for a
 * remembered address: it needs no explanation.
 */
export function addressNoteOf(address: ServeAddress): string | undefined {
  if (address.source === 'derived') return DERIVED_ADDRESS_NOTE
  if (address.source === 'unknown') return UNKNOWN_ADDRESS_NOTE
  return undefined
}
