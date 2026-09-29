import { EXTERNAL_SUPERVISOR } from '../services/constants.js'
import { cliCommand } from './next-step.js'

/**
 * The line `setup` ends with (owner's next-step rule, 2026-09-29): until then
 * a scripted setup stopped at "Save this token now" and the operator had to
 * find out alone that the services still need `start` and where the console
 * is. It goes to stdout with the rest of setup's report — setup's stdout is a
 * person's reading, not data (the token on it already forbids a redirect).
 *
 * Nothing for an `external` supervisor (its notice says compose or systemd
 * owns the processes) or `--no-admin` (its warning already names both ways to
 * the first owner).
 */
export function setupNextStep(
  config: SetupNextStepConfig,
  outcome: { readonly started: boolean; readonly noAdmin: boolean },
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (config.supervisor === EXTERNAL_SUPERVISOR || outcome.noAdmin) return ''
  const start = outcome.started ? '' : `${cliCommand(env)} start, then `
  return `Next: ${start}open ${consoleAddressOf(config.ui)}/ and sign in with your admin token.\n`
}

export interface SetupNextStepConfig {
  readonly supervisor?: string | undefined
  readonly ui: {
    readonly host: string
    readonly port: number
    readonly allowedOrigins?: readonly string[] | undefined
  }
}

const WILDCARD_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '::', ''])
const LOOPBACK_HOST = '127.0.0.1'

/** The public origin when the install names one; otherwise the bind, as a browser types it. */
function consoleAddressOf(ui: SetupNextStepConfig['ui']): string {
  const origin = ui.allowedOrigins?.[0]
  if (origin !== undefined) return origin
  const host = WILDCARD_HOSTS.has(ui.host) ? LOOPBACK_HOST : ui.host
  return `http://${host.includes(':') ? `[${host}]` : host}:${String(ui.port)}`
}
