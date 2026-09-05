import { parseArgs } from 'node:util'
import { formatReadableField } from '../journal/format.js'
import { LOG_TAIL_DEFAULT_LINES, SERVICE_NAMES, type ServiceName } from '../services/constants.js'
import { SERVICE_USAGE } from './operator-usage.js'
import type { ServiceCommandName } from './service-cmd.js'

/**
 * The argument layer of `mcpcut start|stop|status|logs` — argv in, one value
 * out, no disk and no streams. Split from `service-cmd.ts` for the file-size
 * budget, the way `server-add-args.ts` is split from `server-cmd.ts`.
 *
 * `ServiceCommandName` is imported as a TYPE only, so the pair has exactly one
 * runtime edge (command → args) rather than a cycle.
 */

/**
 * `ui` first on the way up, `serve` first on the way down. Neither service
 * depends on the other, but the order an operator sees is not arbitrary: the
 * console comes up before the front that answers agents, and the front that
 * answers agents goes down before the console that would explain why.
 */
const START_ORDER: readonly ServiceName[] = SERVICE_NAMES
const STOP_ORDER: readonly ServiceName[] = [...SERVICE_NAMES].reverse()

export interface OkServiceArgs {
  readonly kind: 'ok'
  /** The services to act on, in the order they are acted on. */
  readonly services: readonly ServiceName[]
  readonly json: boolean
  /** Lines of log tail; only `logs` reads it. */
  readonly lines: number | undefined
}

export type ParsedServiceArgs =
  | OkServiceArgs
  | { readonly kind: 'error'; readonly message: string }

export function parseServiceArgs(
  command: ServiceCommandName,
  args: readonly string[],
): ParsedServiceArgs {
  try {
    if (command === 'status') return parseStatusArgs(args)
    if (command === 'logs') return parseLogsArgs(args)
    return parseStartStopArgs(command, args)
  } catch (error: unknown) {
    // An unknown flag; `parseArgs` in strict mode names it better than we could.
    return usageError(error instanceof Error ? error.message : String(error))
  }
}

function parseStartStopArgs(
  command: 'start' | 'stop',
  args: readonly string[],
): ParsedServiceArgs {
  const { positionals } = parseArgs({
    args: [...args],
    options: {},
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length > 1) {
    return usageError(`${command} takes at most one service name (got: ${readableList(positionals)})`)
  }
  const order = command === 'start' ? START_ORDER : STOP_ORDER
  const named = positionals[0]
  if (named === undefined) return okArgs(order)
  if (!isServiceName(named)) return unknownServiceError(named)
  return okArgs([named])
}

function parseStatusArgs(args: readonly string[]): ParsedServiceArgs {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { json: { type: 'boolean', default: false } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length > 0) {
    return usageError(
      `status takes no positional arguments (got: ${readableList(positionals)}); it always reports every service`,
    )
  }
  return okArgs(START_ORDER, { json: values.json === true })
}

function parseLogsArgs(args: readonly string[]): ParsedServiceArgs {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { lines: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const named = positionals[0]
  if (named === undefined) return usageError('logs needs the service whose log to print: ui or serve')
  if (positionals.length > 1) {
    return usageError(`logs takes exactly one service name (got: ${readableList(positionals)})`)
  }
  if (!isServiceName(named)) return unknownServiceError(named)

  const lines = parseLines(values.lines)
  if (lines === null) {
    return usageError(
      `Invalid --lines "${formatReadableField(String(values.lines))}": expected a positive whole number.`,
    )
  }
  return okArgs([named], { lines })
}

/**
 * `--lines`: a positive whole number, or the default when the flag is absent.
 * Zero is refused rather than treated as "all" or as "none" — both readings
 * are defensible, which is exactly why an operator must not have to guess.
 */
function parseLines(raw: unknown): number | null {
  if (raw === undefined) return LOG_TAIL_DEFAULT_LINES
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null
  const lines = Number(raw)
  return Number.isSafeInteger(lines) && lines > 0 ? lines : null
}

function okArgs(
  services: readonly ServiceName[],
  extra: { readonly json?: boolean; readonly lines?: number } = {},
): OkServiceArgs {
  return { kind: 'ok', services, json: extra.json ?? false, lines: extra.lines }
}

function isServiceName(raw: string): raw is ServiceName {
  return (SERVICE_NAMES as readonly string[]).includes(raw)
}

function unknownServiceError(raw: string): ParsedServiceArgs {
  return usageError(
    `Unknown service "${formatReadableField(raw)}": expected ${SERVICE_NAMES.join(' or ')}.`,
  )
}

function usageError(message: string): ParsedServiceArgs {
  return { kind: 'error', message: `${message}\n\n${SERVICE_USAGE}` }
}

/** Argv echoed back into a message goes through the readable-field screen first. */
function readableList(values: readonly string[]): string {
  return values.map(formatReadableField).join(' ')
}
