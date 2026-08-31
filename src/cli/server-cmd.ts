import { parseArgs } from 'node:util'
import { formatReadableField } from '../journal/format.js'
import { ADD_USAGE, buildCandidate, parseAddArgs } from './server-add-args.js'
import { warnAboutExistingGrants } from './server-grant-refs.js'
import { formatPolicyErrors } from '../policy/load.js'
import { parseServerRecord, type ServerRecord } from '../registry/schema.js'
import { createRegistryStore, type RegistryStore } from '../registry/store.js'
import {
  cascadeGrants,
  cascadeServerRemoval,
  cascadeSummary,
  cascadeTouchedAnything,
  reportCascade,
} from './server-remove-cascade.js'
import {
  printProbedStatus,
  printRegistrationProbe,
  probeListStatusCells,
  type ServerProbeOptions,
} from './server-status-cmd.js'

/**
 * `server add|list|show|remove` — CLI management of the MCP server registry
 * (`registry/store.ts`). Same shape as `policy-cmd.ts`: plain exported
 * functions returning an exit code, with injectable io and journal dir, so
 * `src/cli.ts` can dispatch into them (Wave 4) and tests can drive them
 * without touching real streams. Since M5.5 п.1 (ADR-0008) `list` and `show`
 * also probe stale servers and `add` probes right after registration —
 * `server refresh` and the probe helpers live in `server-status-cmd.ts`.
 *
 * `server show` prints env/header values exactly as stored: the schema
 * guarantees the registry never holds a secret literal (vault references are
 * pointers, not secrets), so there is nothing here to redact.
 */

/** Minimal writable-stream shape these commands need, so tests can inject plain capture objects. */
export interface ServerCliWritable {
  write(chunk: string): unknown
}

export interface ServerCliIo {
  readonly stdout: ServerCliWritable
  readonly stderr: ServerCliWritable
}

export interface ServerCliOptions {
  /** Directory holding `registry.json`. Defaults to `JOURNAL_DIR`. */
  readonly journalDir?: string
  /**
   * Environment holding `MCP_ADMIN_TOKEN`, read for ATTRIBUTION only (the
   * `approvals-cmd.ts` seam): probe records, and since M5.5 п.2 the
   * `server remove` cascade record. Never an access barrier — a missing token
   * downgrades the record to unattributed, it does not refuse the command.
   * Defaults to `process.env`.
   */
  readonly env?: NodeJS.ProcessEnv
  /** Probe seams for tests (engine stub, horizons, list deadline, clock). */
  readonly probes?: ServerProbeOptions
}

const DEFAULT_IO: ServerCliIo = { stdout: process.stdout, stderr: process.stderr }

/** Max characters of the command/url column in `server list` before shortening. */
const MAX_LIST_TARGET_CHARS = 48

const LIST_USAGE = `Usage:
  server list   List registered servers with live status (stale servers are probed)
`

const SHOW_USAGE = `Usage:
  server show <name>   Print the full registry record and current status for one server
`

const REMOVE_USAGE = `Usage:
  server remove <name>   Remove a server from the registry
`

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function makeStore(opts: ServerCliOptions): RegistryStore {
  return createRegistryStore(opts.journalDir)
}

/** `server add <name> --transport ... `: validates and persists a new record. */
export async function runServerAdd(
  args: string[],
  io: ServerCliIo = DEFAULT_IO,
  opts: ServerCliOptions = {},
): Promise<number> {
  const parsed = parseAddArgs(args)
  if (parsed === undefined) {
    io.stderr.write(ADD_USAGE)
    return 1
  }

  const built = buildCandidate(parsed.name, parsed.values)
  if (!built.ok) {
    io.stderr.write(`${built.message}\n`)
    return 1
  }

  const result = parseServerRecord(built.candidate)
  if (!result.ok) {
    for (const line of formatPolicyErrors(result.error)) {
      io.stderr.write(`${line}\n`)
    }
    return 1
  }

  try {
    await makeStore(opts).addServer(result.record)
  } catch (error: unknown) {
    io.stderr.write(`${describeError(error)}\n`)
    return 1
  }
  io.stdout.write(`added server "${result.record.name}" (${result.record.transport})\n`)
  // M3a: the name may still be granted by agents or groups from an earlier
  // registration, which would silently hand them access to this new server.
  await warnAboutExistingGrants(result.record.name, io, opts)
  // One forced probe with `tools/list` right after registration (O8,
  // ADR-0008): liveness — or why the plane could not even try — without a
  // single agent call. The record is already written; exit stays 0.
  await printRegistrationProbe(result.record.name, io, opts)
  return 0
}

/** The command (stdio) or url (http) a record points at, shortened for the list table. */
function listTarget(record: ServerRecord): string {
  const target = record.transport === 'stdio' ? record.command : record.url
  const shortened =
    target.length > MAX_LIST_TARGET_CHARS ? `${target.slice(0, MAX_LIST_TARGET_CHARS)}…` : target
  return formatReadableField(shortened)
}

function formatServerTable(records: readonly ServerRecord[], statusCells: readonly string[]): string {
  const rows = [
    ['NAME', 'TRANSPORT', 'TARGET', 'STATUS'],
    ...records.map((record, index) => [record.name, record.transport, listTarget(record), statusCells[index] ?? '']),
  ]
  const widths = [0, 1, 2].map((column) => Math.max(...rows.map((row) => (row[column] ?? '').length)))
  const cell = (row: readonly string[], column: number): string =>
    (row[column] ?? '').padEnd(widths[column] ?? 0)
  return `${rows
    .map((row) => `${cell(row, 0)}  ${cell(row, 1)}  ${cell(row, 2)}  ${row[3] ?? ''}`)
    .join('\n')}\n`
}

/**
 * `server list`: registry table plus a live STATUS column — stale servers
 * are probed concurrently under the shared deadline first (owner decision
 * 2026-08-24: list PROBES, like `claude mcp list`); fresh come from the store.
 */
export async function runServerList(
  args: string[],
  io: ServerCliIo = DEFAULT_IO,
  opts: ServerCliOptions = {},
): Promise<number> {
  try {
    parseArgs({ args: [...args], options: {}, allowPositionals: false, strict: true })
  } catch {
    io.stderr.write(LIST_USAGE)
    return 1
  }

  let records: readonly ServerRecord[]
  try {
    records = await makeStore(opts).listServers()
  } catch (error: unknown) {
    io.stderr.write(`${describeError(error)}\n`)
    return 1
  }

  if (records.length === 0) {
    io.stdout.write('(no servers registered)\n')
    return 0
  }
  const statusCells = await probeListStatusCells(records.map((record) => record.name), io, opts)
  io.stdout.write(formatServerTable(records, statusCells))
  return 0
}

/** `label:` plus one indented `key: value` line per entry; empty maps render nothing. */
function formatValueMap(label: string, map: Record<string, string> | undefined): string[] {
  const entries = Object.entries(map ?? {})
  if (entries.length === 0) {
    return []
  }
  return [
    `${label}:`,
    ...entries.map(([key, value]) => `  ${formatReadableField(key)}: ${formatReadableField(value)}`),
  ]
}

function formatServerRecord(record: ServerRecord): string {
  const lines = [`name: ${record.name}`, `transport: ${record.transport}`]
  if (record.transport === 'stdio') {
    lines.push(`command: ${formatReadableField(record.command)}`)
    if (record.args !== undefined && record.args.length > 0) {
      lines.push(`args: ${record.args.map(formatReadableField).join(' ')}`)
    }
    lines.push(...formatValueMap('env', record.env))
  } else {
    lines.push(`url: ${formatReadableField(record.url)}`, `protocol: ${record.protocol}`)
    lines.push(...formatValueMap('headers', record.headers))
  }
  return `${lines.join('\n')}\n`
}

/** Parses the single `<name>` positional shared by `show` and `remove`. */
function parseNameArg(args: string[], usage: string, io: ServerCliIo): string | undefined {
  try {
    const parsed = parseArgs({ args: [...args], options: {}, allowPositionals: true, strict: true })
    if (parsed.positionals.length === 1 && parsed.positionals[0] !== undefined) {
      return parsed.positionals[0]
    }
  } catch {
    // fall through to usage
  }
  io.stderr.write(usage)
  return undefined
}

/** `server show <name>`: prints the full record (vault references shown as-is). */
export async function runServerShow(
  args: string[],
  io: ServerCliIo = DEFAULT_IO,
  opts: ServerCliOptions = {},
): Promise<number> {
  const name = parseNameArg(args, SHOW_USAGE, io)
  if (name === undefined) {
    return 1
  }

  let record: ServerRecord | undefined
  try {
    record = await makeStore(opts).getServer(name)
  } catch (error: unknown) {
    io.stderr.write(`${describeError(error)}\n`)
    return 1
  }

  if (record === undefined) {
    io.stderr.write(`unknown server "${formatReadableField(name)}"\n`)
    return 1
  }
  io.stdout.write(formatServerRecord(record))
  // A stale status is refreshed by one synchronous probe (bounded by the
  // probe timeout); a fresh one is printed straight from the store (O1/O2).
  await printProbedStatus(record.name, io, opts)
  return 0
}

/**
 * The `not-found` branch of `server remove` doubles as the REPAIR path: the
 * three documents share no transaction, so a crash (or a half-failed cascade)
 * can leave grants pointing at a name the registry no longer knows. Both
 * cascade halves are idempotent, so running them again either prunes what
 * dangled — reported, audited and journalled like any other removal — or
 * finds nothing, which is the plain "unknown server" of before.
 */
async function repairDanglingGrants(
  name: string,
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<number> {
  const cascade = await cascadeGrants(name, io, opts)
  if (!cascadeTouchedAnything(cascade)) {
    io.stderr.write(`unknown server "${formatReadableField(name)}"\n`)
    return 1
  }
  await reportCascade(name, cascade, io, opts)
  io.stdout.write(
    `server "${formatReadableField(name)}" was not registered; ` +
      `pruned dangling grants: ${cascadeSummary(cascade)}\n`,
  )
  return 0
}

/**
 * `server remove <name>`. The registry write comes first, then the cascade
 * that strips the server from agent grants and groups (G6), then the audit
 * line, the journal record and the report. Exit stays 0 once the server is
 * gone — including when the journal dropped the record or one cascade half
 * failed, both of which are reported rather than hidden.
 */
export async function runServerRemove(
  args: string[],
  io: ServerCliIo = DEFAULT_IO,
  opts: ServerCliOptions = {},
): Promise<number> {
  const name = parseNameArg(args, REMOVE_USAGE, io)
  if (name === undefined) {
    return 1
  }

  let removed: string
  try {
    const result = await makeStore(opts).removeServer(name)
    if (result.status === 'not-found') {
      return await repairDanglingGrants(name, io, opts)
    }
    removed = result.record.name
  } catch (error: unknown) {
    io.stderr.write(`${describeError(error)}\n`)
    return 1
  }

  // Past this point the registry write has LANDED: nothing may turn the
  // command into a failure, and the cascade — which never throws — always
  // leaves an audit line and an `access-edit` record behind.
  const cascade = await cascadeServerRemoval(removed, io, opts)
  io.stdout.write(`removed server "${removed}"; cascaded: ${cascadeSummary(cascade)}\n`)
  return 0
}
