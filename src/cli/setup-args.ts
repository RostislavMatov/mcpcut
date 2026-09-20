import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { formatReadableField } from '../journal/format.js'
import { SUPERVISORS, type Supervisor } from '../setup/constants.js'
import { applyPublicUrl, parsePublicUrl, type PublicUrl } from '../setup/public-url.js'
import type { InstallConfig } from '../setup/schema.js'
import { MAX_TCP_PORT } from './serve-constants.js'

/**
 * The argument layer of `mcpcut setup` (phase 1, Task 14): usage text, flag
 * shapes and the one value the command runs on. Split from `setup-cmd.ts` the
 * way `server-add-args.ts` is split from `server-cmd.ts` — this module knows
 * only about argv and never touches disk, a store or a stream. The overlay
 * below is no exception: `resolve(cwd, dataDir)` is `node:path` computing a
 * string, and never asks the filesystem whether the directory exists.
 *
 * Every flag is OPTIONAL in the result, and deliberately so: `setup` overlays
 * only what the operator actually typed onto the config that already exists,
 * so a rerun that passes `--ui-port` alone must not silently reset the
 * `behindTls` or `allowedHosts` an earlier run wrote. "Not given" and "given
 * the default value" are different facts and the type keeps them apart.
 */

/**
 * Re-exported, not written here: the same synopsis is spliced into the global
 * `--help` table, and one text is the only way the two can never disagree
 * (`./operator-usage.ts`).
 */
export { SETUP_USAGE } from './operator-usage.js'

/** What the operator asked for. Absent fields were not typed and are not overlaid. */
export interface SetupArgs {
  /** The non-interactive acknowledgement; without it `setup` only points at the wizard to come. */
  readonly yes: boolean
  /** Overwrite an install config this build cannot read. */
  readonly force: boolean
  /** Start both services once the install is prepared. */
  readonly start: boolean
  /** Leave the install with no admin: the first `ui` start serves `/setup` and writes its one-time code to a file. */
  readonly noAdmin: boolean
  readonly behindTls?: boolean
  readonly dataDir?: string
  readonly uiHost?: string
  readonly uiPort?: number
  /** Where a pid-less `status` dials the UI (compose: the service name); never the bind. */
  readonly uiProbeHost?: string
  readonly serveHost?: string
  readonly servePort?: number
  /** Where a pid-less `status` dials `serve` (compose: the service name); never the bind. */
  readonly serveProbeHost?: string
  readonly admin?: string
  readonly supervisor?: Supervisor
  /** The address the admin UI will be opened at; allow-lists, TLS and (for plain http) the bind follow from it. */
  readonly uiPublicUrl?: PublicUrl
  /** The address agents will dial `serve` at; its Host entry and (for plain http) the bind follow from it. */
  readonly servePublicUrl?: PublicUrl
}

/**
 * Nothing was typed. The value a caller that has no argv at all overlays — the
 * first-run wizard, which fills the config from a form rather than from flags
 * and must still go through one overlay so both surfaces write the same shape.
 */
export const NO_SETUP_ARGS: SetupArgs = { yes: false, force: false, start: false, noAdmin: false }

/**
 * The base config with the flags the operator actually typed laid over it.
 * Immutable throughout: a rerun that passes `--ui-port` alone must keep the
 * `behindTls`, `allowedHosts` and `trustedProxyHeader` an earlier run wrote,
 * so every field that was not asked about is carried across untouched.
 */
export function overlaySetupArgs(base: InstallConfig, args: SetupArgs, cwd: string): InstallConfig {
  return withPublicUrls(overlayTypedFlags(base, args, cwd), args)
}

/**
 * The public addresses, laid over the flags rather than beside them: a bind
 * or a TLS word the operator typed in the same run always wins over what an
 * address would have implied.
 */
function withPublicUrls(config: InstallConfig, args: SetupArgs): InstallConfig {
  const { uiPublicUrl, servePublicUrl } = args
  return {
    ...config,
    ...(uiPublicUrl !== undefined
      ? {
          ui: {
            ...applyPublicUrl(config.ui, uiPublicUrl, { isHostTyped: args.uiHost !== undefined, withOrigin: true }),
            behindTls: args.behindTls ?? uiPublicUrl.scheme === 'https',
          },
        }
      : {}),
    ...(servePublicUrl !== undefined
      ? {
          serve: applyPublicUrl(config.serve, servePublicUrl, {
            isHostTyped: args.serveHost !== undefined,
            withOrigin: false,
          }),
        }
      : {}),
  }
}

function overlayTypedFlags(base: InstallConfig, args: SetupArgs, cwd: string): InstallConfig {
  return {
    ...base,
    // `resolve` returns an absolute path unchanged, so this is the one branch
    // that handles both spellings of `--data-dir`.
    ...(args.dataDir !== undefined ? { dataDir: resolve(cwd, args.dataDir) } : {}),
    ui: {
      ...base.ui,
      ...(args.uiHost !== undefined ? { host: args.uiHost } : {}),
      ...(args.uiPort !== undefined ? { port: args.uiPort } : {}),
      // Written whenever the operator said either word: `--behind-tls` is
      // remembered in the file, so `--no-behind-tls` has to be able to write
      // the `false` that takes it back.
      ...(args.behindTls !== undefined ? { behindTls: args.behindTls } : {}),
      ...(args.uiProbeHost !== undefined ? { probeHost: args.uiProbeHost } : {}),
    },
    serve: {
      ...base.serve,
      ...(args.serveHost !== undefined ? { host: args.serveHost } : {}),
      ...(args.servePort !== undefined ? { port: args.servePort } : {}),
      ...(args.serveProbeHost !== undefined ? { probeHost: args.serveProbeHost } : {}),
    },
    ...(args.supervisor !== undefined ? { supervisor: args.supervisor } : {}),
  }
}

export type SetupArgsResult =
  | { readonly ok: true; readonly args: SetupArgs }
  | { readonly ok: false; readonly message: string }

/** Flag values straight out of `parseArgs`, before any of them means anything. */
interface SetupFlagValues {
  readonly yes?: boolean | undefined
  readonly force?: boolean | undefined
  readonly start?: boolean | undefined
  readonly 'behind-tls'?: boolean | undefined
  readonly 'no-behind-tls'?: boolean | undefined
  readonly 'no-admin'?: boolean | undefined
  readonly 'data-dir'?: string | undefined
  readonly 'ui-host'?: string | undefined
  readonly 'ui-port'?: string | undefined
  readonly 'ui-probe-host'?: string | undefined
  readonly 'serve-host'?: string | undefined
  readonly 'serve-port'?: string | undefined
  readonly 'serve-probe-host'?: string | undefined
  readonly admin?: string | undefined
  readonly supervisor?: string | undefined
  readonly 'ui-public-url'?: string | undefined
  readonly 'serve-public-url'?: string | undefined
}

/** Parses `setup` argv; every refusal is a sentence, never a bare `undefined`. */
export function parseSetupArgs(args: readonly string[]): SetupArgsResult {
  const parsed = parseFlags(args)
  if (!parsed.ok) return parsed

  const uiPort = parsePortFlag('--ui-port', parsed.values['ui-port'])
  if (!uiPort.ok) return uiPort
  const servePort = parsePortFlag('--serve-port', parsed.values['serve-port'])
  if (!servePort.ok) return servePort
  const supervisor = parseSupervisorFlag(parsed.values.supervisor)
  if (!supervisor.ok) return supervisor

  const admin = parsed.values.admin
  const noAdmin = parsed.values['no-admin'] === true
  if (admin !== undefined && noAdmin) {
    return { ok: false, message: oppositeFlags('--admin', '--no-admin') }
  }

  const behindTls = parseBehindTlsFlags(parsed.values)
  if (!behindTls.ok) return behindTls
  const uiPublicUrl = parsePublicUrlFlag('--ui-public-url', parsed.values['ui-public-url'])
  if (!uiPublicUrl.ok) return uiPublicUrl
  const servePublicUrl = parsePublicUrlFlag('--serve-public-url', parsed.values['serve-public-url'])
  if (!servePublicUrl.ok) return servePublicUrl

  return {
    ok: true,
    args: {
      yes: parsed.values.yes === true,
      force: parsed.values.force === true,
      start: parsed.values.start === true,
      noAdmin,
      ...(behindTls.behindTls !== undefined ? { behindTls: behindTls.behindTls } : {}),
      ...optionalString('dataDir', parsed.values['data-dir']),
      ...optionalString('uiHost', parsed.values['ui-host']),
      ...(uiPort.port !== undefined ? { uiPort: uiPort.port } : {}),
      ...optionalString('uiProbeHost', parsed.values['ui-probe-host']),
      ...optionalString('serveHost', parsed.values['serve-host']),
      ...(servePort.port !== undefined ? { servePort: servePort.port } : {}),
      ...optionalString('serveProbeHost', parsed.values['serve-probe-host']),
      ...optionalString('admin', admin),
      ...(supervisor.supervisor !== undefined ? { supervisor: supervisor.supervisor } : {}),
      ...(uiPublicUrl.url !== undefined ? { uiPublicUrl: uiPublicUrl.url } : {}),
      ...(servePublicUrl.url !== undefined ? { servePublicUrl: servePublicUrl.url } : {}),
    },
  }
}

type PublicUrlFlagResult =
  | { readonly ok: true; readonly url?: PublicUrl }
  | { readonly ok: false; readonly message: string }

/** An absent flag is a result, not a refusal; an empty value is the env var of a compose file left unset. */
function parsePublicUrlFlag(flag: string, raw: string | undefined): PublicUrlFlagResult {
  if (raw === undefined || raw === '') return { ok: true }
  return parsePublicUrl(flag, raw)
}

type FlagsResult =
  | { readonly ok: true; readonly values: SetupFlagValues }
  | { readonly ok: false; readonly message: string }

/**
 * Strict `parseArgs` with no positionals: `setup` is described entirely by
 * flags, and a stray word is far more likely to be a typo'd flag value than
 * something to ignore. `parseArgs`'s own message already names the offending
 * token, so it is passed through (sanitized — the token is operator input).
 */
function parseFlags(args: readonly string[]): FlagsResult {
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        yes: { type: 'boolean' },
        force: { type: 'boolean' },
        start: { type: 'boolean' },
        'behind-tls': { type: 'boolean' },
        'no-behind-tls': { type: 'boolean' },
        'no-admin': { type: 'boolean' },
        'data-dir': { type: 'string' },
        'ui-host': { type: 'string' },
        'ui-port': { type: 'string' },
        'ui-probe-host': { type: 'string' },
        'serve-host': { type: 'string' },
        'serve-port': { type: 'string' },
        'serve-probe-host': { type: 'string' },
        admin: { type: 'string' },
        supervisor: { type: 'string' },
        'ui-public-url': { type: 'string' },
        'serve-public-url': { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    if (parsed.positionals.length > 0) {
      return {
        ok: false,
        message: `setup takes no positional arguments (got: ${formatReadableField(parsed.positionals.join(' '))})`,
      }
    }
    return { ok: true, values: parsed.values }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: formatReadableField(message) }
  }
}

type PortResult =
  | { readonly ok: true; readonly port: number | undefined }
  | { readonly ok: false; readonly message: string }

/**
 * `0..MAX_TCP_PORT`, digits only — the same rule and the same sentence
 * `parseUiFlags` applies to `--port`, so the two surfaces refuse identically.
 */
function parsePortFlag(flag: string, raw: string | undefined): PortResult {
  if (raw === undefined) return { ok: true, port: undefined }
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_TCP_PORT) {
    return {
      ok: false,
      message: `Invalid ${flag} "${formatReadableField(raw)}": expected 0..${MAX_TCP_PORT}.`,
    }
  }
  return { ok: true, port: Number(raw) }
}

type SupervisorResult =
  | { readonly ok: true; readonly supervisor: Supervisor | undefined }
  | { readonly ok: false; readonly message: string }

/** The closed list is checked here, not by the schema, so the refusal names the flag. */
function parseSupervisorFlag(raw: string | undefined): SupervisorResult {
  if (raw === undefined) return { ok: true, supervisor: undefined }
  const match = SUPERVISORS.find((supervisor) => supervisor === raw)
  if (match === undefined) {
    return {
      ok: false,
      message: `Invalid --supervisor "${formatReadableField(raw)}": expected one of ${SUPERVISORS.join(', ')}.`,
    }
  }
  return { ok: true, supervisor: match }
}

type BehindTlsResult =
  | { readonly ok: true; readonly behindTls: boolean | undefined }
  | { readonly ok: false; readonly message: string }

/**
 * `--behind-tls` / `--no-behind-tls`, as an explicit tri-state.
 *
 * `undefined` means neither was typed, and the config keeps whatever an
 * earlier run put there — `behindTls` is written to the file, so it survives a
 * rerun that does not mention it. That is why the negative flag exists at all:
 * without it the claim "TLS is terminated in front of me" could be made from
 * the CLI but only ever taken back by hand-editing the config, which is the
 * one flag whose staleness silences an exposure warning.
 */
function parseBehindTlsFlags(values: SetupFlagValues): BehindTlsResult {
  const on = values['behind-tls'] === true
  const off = values['no-behind-tls'] === true
  if (on && off) return { ok: false, message: oppositeFlags('--behind-tls', '--no-behind-tls') }
  if (on) return { ok: true, behindTls: true }
  if (off) return { ok: true, behindTls: false }
  return { ok: true, behindTls: undefined }
}

/**
 * One sentence for every pair of flags that contradict each other. Refused
 * rather than resolved by precedence: an operator who typed both meant one of
 * them, and there is no way to tell which.
 */
function oppositeFlags(positive: string, negative: string): string {
  return `${positive} and ${negative} ask for opposite things: pass one or neither.`
}

/**
 * Conditional spread of one string field, so `exactOptionalPropertyTypes` stays
 * honest.
 *
 * `K extends keyof SetupArgs`, not `K extends string`: with the looser bound a
 * mistyped key (`'uiHst'`) produced a perfectly valid `Record<'uiHst', string>`
 * that the result object then absorbed and nobody ever read — the flag would
 * silently stop working (TS-M6). The narrower bound also rejects a string
 * spread onto a numeric field (`uiPort`).
 */
function optionalString<K extends keyof SetupArgs>(
  key: K,
  value: string | undefined,
): Record<K, string> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>)
}
