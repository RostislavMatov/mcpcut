import { parseArgs } from 'node:util'
import { isRejectedOriginFlagValue } from '../net/origin-host.js'
import type { ServeServiceDefaults } from '../setup/bind.js'
import { MAX_TCP_PORT } from './serve-constants.js'

/**
 * `serve`'s flags, parsed strictly and merged over the configured defaults.
 * Its own file so `serve-cmd.ts` keeps to the run's lifecycle.
 */

export interface ServeFlags {
  readonly port: number
  readonly host: string
  readonly policyPath: string | undefined
  readonly failClosed: boolean
  readonly allowedOrigins: readonly string[]
  readonly allowedHosts: readonly string[]
}

type FlagResult = { readonly flags: ServeFlags } | { readonly error: string }

/** Parses serve's flags strictly: an unknown option is a hard error. */
export function parseServeFlags(argv: readonly string[], defaults: ServeServiceDefaults): FlagResult {
  let values: Record<string, unknown>
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        policy: { type: 'string' },
        'fail-closed': { type: 'boolean', default: false },
        'allowed-origin': { type: 'string', multiple: true },
        'allowed-host': { type: 'string', multiple: true },
      },
      allowPositionals: false,
      strict: true,
    })
    values = parsed.values
  } catch {
    return { error: 'Unknown or malformed option(s) in serve command.' }
  }
  return buildServeFlags(values, defaults)
}

/**
 * Merges the parsed flags over `defaults` (phase 1, task 5): a flag the
 * operator typed always wins, and only a flag that is absent takes the
 * configured value. For the repeatable flags "absent" means "not given once" —
 * a single `--allowed-host` replaces the configured list rather than adding to
 * it, so what the command line says is what the front screens against.
 */
function buildServeFlags(
  values: Record<string, unknown>,
  defaults: ServeServiceDefaults,
): FlagResult {
  const port = parsePort(values['port'], defaults.port)
  if (port === null) {
    return { error: `Invalid --port "${String(values['port'])}": expected 0..${MAX_TCP_PORT}.` }
  }
  const host = typeof values['host'] === 'string' ? values['host'] : defaults.host
  if (host.length === 0) {
    return { error: 'Invalid --host: expected a non-empty address.' }
  }
  // Only the flag's own values are screened here: the install config's schema
  // already refuses the opaque origin, so a config value cannot reach this.
  const flagOrigins = Array.isArray(values['allowed-origin'])
    ? (values['allowed-origin'] as string[])
    : undefined
  if (flagOrigins?.some(isRejectedOriginFlagValue) === true) {
    return { error: `Invalid --allowed-origin "null": the opaque origin can never be allowed.` }
  }
  const flagHosts = Array.isArray(values['allowed-host'])
    ? (values['allowed-host'] as string[])
    : undefined
  const policyPath = typeof values['policy'] === 'string' ? values['policy'] : defaults.policy

  return {
    flags: {
      port,
      host,
      policyPath,
      // `--fail-closed` only ever turns fail-closed ON (see `applyFailClosed`),
      // so a config that asks for it cannot be softened by omitting the flag.
      failClosed: values['fail-closed'] === true ? true : (defaults.failClosed ?? false),
      allowedOrigins: flagOrigins ?? defaults.allowedOrigins ?? [],
      allowedHosts: flagHosts ?? defaults.allowedHosts ?? [],
    },
  }
}

/** `0` (any free port) through 65535; anything else is a usage error. */
function parsePort(raw: unknown, fallback: number): number | null {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null
  const port = Number(raw)
  return port <= MAX_TCP_PORT ? port : null
}
