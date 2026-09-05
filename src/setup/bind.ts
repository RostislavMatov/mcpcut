import { DEFAULT_SERVE_HOST, DEFAULT_SERVE_PORT, MAX_TCP_PORT } from '../cli/serve-constants.js'
import { DEFAULT_UI_HOST, DEFAULT_UI_PORT } from '../cli/ui-constants.js'
import {
  SERVE_HOST_ENV_VAR,
  SERVE_PORT_ENV_VAR,
  UI_HOST_ENV_VAR,
  UI_PORT_ENV_VAR,
} from './constants.js'
import type { InstallConfigLoad } from './load.js'

/**
 * What `ui` and `serve` bind to when their flags are silent (phase 1, task 5).
 *
 * The order is `MCPCUT_<SVC>_<HOST|PORT>` > the install config > the
 * `DEFAULT_*` constants the flags have always defaulted to, with the flags
 * themselves above all three — so an install with neither an environment
 * override nor a config file behaves byte-for-byte as before.
 *
 * The rest of each service's configuration (`behindTls`, the allowlists, the
 * policy path, `failClosed`) comes from the config alone: those are
 * deployment shape, not a knob worth a second spelling in the environment.
 * They are OPTIONAL here on purpose — "absent" and "explicitly empty" mean
 * different things to a command that must not overwrite its own flags.
 *
 * NOT part of the `src/config.ts` resolution chain (see `./constants.ts`), so
 * this module may reach `../cli/ui-constants.js` for the UI's defaults.
 */

/** Host and port one service will bind. */
export interface BindDefaults {
  readonly host: string
  readonly port: number
}

/** `ui`'s defaults: the bind plus the hardening its flags also carry. */
export interface UiServiceDefaults extends BindDefaults {
  readonly behindTls?: boolean
  readonly allowedHosts?: readonly string[]
  readonly allowedOrigins?: readonly string[]
  readonly trustedProxyHeader?: string
}

/** `serve`'s defaults: the bind plus the policy and screening its flags carry. */
export interface ServeServiceDefaults extends BindDefaults {
  readonly allowedOrigins?: readonly string[]
  readonly allowedHosts?: readonly string[]
  readonly failClosed?: boolean
  readonly policy?: string
}

/**
 * An environment variable that cannot mean what it says. Refused rather than
 * ignored: a `MCPCUT_UI_PORT=8O91` (letter O) that silently fell back to 8091
 * would leave an operator convinced the plane listens where it does not.
 */
export class InvalidBindEnvError extends Error {
  readonly variable: string

  constructor(variable: string, raw: string) {
    super(`Invalid ${variable} "${raw}": expected 0..${MAX_TCP_PORT}.`)
    this.name = 'InvalidBindEnvError'
    this.variable = variable
  }
}

/** `ui`'s defaults, ranked env > config > constants. Throws `InvalidBindEnvError`. */
export function resolveUiDefaults(
  env: NodeJS.ProcessEnv,
  load: InstallConfigLoad,
): UiServiceDefaults {
  const configured = load.kind === 'ok' ? load.config.ui : undefined
  return {
    host: hostFrom(env, UI_HOST_ENV_VAR, configured?.host, DEFAULT_UI_HOST),
    port: portFrom(env, UI_PORT_ENV_VAR, configured?.port, DEFAULT_UI_PORT),
    ...(configured?.behindTls !== undefined ? { behindTls: configured.behindTls } : {}),
    ...(configured?.allowedHosts !== undefined ? { allowedHosts: configured.allowedHosts } : {}),
    ...(configured?.allowedOrigins !== undefined
      ? { allowedOrigins: configured.allowedOrigins }
      : {}),
    ...(configured?.trustedProxyHeader !== undefined
      ? { trustedProxyHeader: configured.trustedProxyHeader }
      : {}),
  }
}

/** `serve`'s defaults, ranked env > config > constants. Throws `InvalidBindEnvError`. */
export function resolveServeDefaults(
  env: NodeJS.ProcessEnv,
  load: InstallConfigLoad,
): ServeServiceDefaults {
  const configured = load.kind === 'ok' ? load.config.serve : undefined
  return {
    host: hostFrom(env, SERVE_HOST_ENV_VAR, configured?.host, DEFAULT_SERVE_HOST),
    port: portFrom(env, SERVE_PORT_ENV_VAR, configured?.port, DEFAULT_SERVE_PORT),
    ...(configured?.allowedOrigins !== undefined
      ? { allowedOrigins: configured.allowedOrigins }
      : {}),
    ...(configured?.allowedHosts !== undefined ? { allowedHosts: configured.allowedHosts } : {}),
    ...(configured?.failClosed !== undefined ? { failClosed: configured.failClosed } : {}),
    ...(configured?.policy !== undefined ? { policy: configured.policy } : {}),
  }
}

/** An exported-but-empty variable is how a shell spells "no value" (`admin-token.ts`). */
function hostFrom(
  env: NodeJS.ProcessEnv,
  variable: string,
  configured: string | undefined,
  fallback: string,
): string {
  const raw = env[variable]
  if (raw !== undefined && raw !== '') return raw
  return configured ?? fallback
}

/**
 * Same range the `--port` flags accept, refused in the same words — `0` (any
 * free port) through `MAX_TCP_PORT`, digits only, so `-1` and `80.5` are
 * faults rather than silently truncated ports. A config port needs no such
 * check: the schema already bounded it.
 */
function portFrom(
  env: NodeJS.ProcessEnv,
  variable: string,
  configured: number | undefined,
  fallback: number,
): number {
  const raw = env[variable]
  if (raw === undefined || raw === '') return configured ?? fallback
  if (!/^\d+$/.test(raw)) throw new InvalidBindEnvError(variable, raw)
  const port = Number(raw)
  if (port > MAX_TCP_PORT) throw new InvalidBindEnvError(variable, raw)
  return port
}
