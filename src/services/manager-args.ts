import {
  FLAG_ALLOWED_HOST,
  FLAG_ALLOWED_ORIGIN,
  FLAG_BEHIND_TLS,
  FLAG_FAIL_CLOSED,
  FLAG_HOST,
  FLAG_POLICY,
  FLAG_PORT,
  FLAG_TRUSTED_PROXY_HEADER,
  type ServiceName,
} from './constants.js'
import { bindOf, type ManagerContext } from './manager-types.js'
import type { InstallConfig } from '../setup/schema.js'

/**
 * The argv of a managed service, spelled the way `ui`/`serve` parse it
 * (mcpcut phase 1, Task 11).
 *
 * The configured surface is passed as FLAGS rather than left for the child to
 * read out of the config file: `ps` and the daemon log then show the
 * configuration the process is actually running with, which is the only view
 * an operator has of a process that outlived the terminal that started it.
 */
export function serviceArgs(ctx: ManagerContext, service: ServiceName): string[] {
  const bind = bindOf(ctx.config, service)
  return [
    ctx.cliPath,
    service,
    FLAG_HOST,
    bind.host,
    FLAG_PORT,
    String(bind.port),
    ...surfaceFlags(ctx.config, service),
  ]
}

function surfaceFlags(config: InstallConfig, service: ServiceName): string[] {
  return service === 'ui' ? uiFlags(config.ui) : serveFlags(config.serve)
}

function uiFlags(ui: InstallConfig['ui']): string[] {
  return [
    ...(ui.behindTls === true ? [FLAG_BEHIND_TLS] : []),
    ...repeatedFlag(FLAG_ALLOWED_HOST, ui.allowedHosts),
    ...repeatedFlag(FLAG_ALLOWED_ORIGIN, ui.allowedOrigins),
    ...(ui.trustedProxyHeader !== undefined ? [FLAG_TRUSTED_PROXY_HEADER, ui.trustedProxyHeader] : []),
  ]
}

function serveFlags(serve: InstallConfig['serve']): string[] {
  return [
    ...(serve.policy !== undefined ? [FLAG_POLICY, serve.policy] : []),
    ...(serve.failClosed === true ? [FLAG_FAIL_CLOSED] : []),
    ...repeatedFlag(FLAG_ALLOWED_ORIGIN, serve.allowedOrigins),
    ...repeatedFlag(FLAG_ALLOWED_HOST, serve.allowedHosts),
  ]
}

/** `--flag a --flag b`, the repeated form both commands parse with `multiple: true`. */
function repeatedFlag(flag: string, values: readonly string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => [flag, value])
}
