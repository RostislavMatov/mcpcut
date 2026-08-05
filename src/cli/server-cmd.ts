import { parseArgs } from 'node:util'
import { formatReadableField } from '../journal/format.js'
import { formatPolicyErrors } from '../policy/load.js'
import { parseServerRecord, type ServerRecord } from '../registry/schema.js'
import { createRegistryStore, type RegistryStore } from '../registry/store.js'

/**
 * `server add|list|show|remove` — CLI management of the MCP server registry
 * (`registry/store.ts`). Same shape as `policy-cmd.ts`: plain exported
 * functions returning an exit code, with injectable io and journal dir, so
 * `src/cli.ts` can dispatch into them (Wave 4) and tests can drive them
 * without touching real streams.
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
}

const DEFAULT_IO: ServerCliIo = { stdout: process.stdout, stderr: process.stderr }

/** Max characters of the command/url column in `server list` before shortening. */
const MAX_LIST_TARGET_CHARS = 48

const ADD_USAGE = `Usage:
  server add <name> --transport stdio|http
    stdio:  --command <cmd> [--args a,b,c] [--env K=V]...
    http:   --url <url> [--header K=V]... [--protocol sessionful|stateless|auto]
  Env/header values are either non-secret literals or vault references (vault:<name>).
`

const LIST_USAGE = `Usage:
  server list   List registered servers
`

const SHOW_USAGE = `Usage:
  server show <name>   Print the full registry record for one server
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

/** Flag values `server add` accepts, straight out of `parseArgs`. */
interface AddFlagValues {
  readonly transport?: string | undefined
  readonly command?: string | undefined
  readonly args?: string | undefined
  readonly env?: string[] | undefined
  readonly url?: string | undefined
  readonly header?: string[] | undefined
  readonly protocol?: string | undefined
}

/** Flags of `server add` that take a value (used by `normalizeInlineValues`). */
const ADD_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--transport',
  '--command',
  '--args',
  '--env',
  '--url',
  '--header',
  '--protocol',
])

/**
 * Rewrites `--flag value` into `--flag=value` for known value-taking flags.
 * `parseArgs` rejects a space-separated value that starts with a dash
 * (`--args -y,...` → "argument is ambiguous"), but that is exactly how the
 * documented onboarding script passes stdio args. Joining the pair is
 * semantically identical for every non-dash value and simply also accepts
 * dash-leading ones.
 */
function normalizeInlineValues(args: readonly string[]): string[] {
  const normalized: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i]
    const next = args[i + 1]
    if (current !== undefined && ADD_VALUE_FLAGS.has(current) && next !== undefined) {
      normalized.push(`${current}=${next}`)
      i += 1
      continue
    }
    if (current !== undefined) {
      normalized.push(current)
    }
  }
  return normalized
}

type PairsResult =
  | { readonly ok: true; readonly map: Record<string, string> | undefined }
  | { readonly ok: false; readonly message: string }

/**
 * Parses repeatable `K=V` flag values into a map. The accumulator has a null
 * prototype so a `__proto__` key becomes an own property (which the schema
 * pre-scan then rejects loudly) instead of silently rewiring the prototype.
 */
function parseKeyValuePairs(values: readonly string[] | undefined, flag: string): PairsResult {
  if (values === undefined || values.length === 0) {
    return { ok: true, map: undefined }
  }
  const map: Record<string, string> = Object.create(null) as Record<string, string>
  for (const pair of values) {
    const separatorIndex = pair.indexOf('=')
    if (separatorIndex <= 0) {
      return { ok: false, message: `invalid ${flag} value "${formatReadableField(pair)}": expected K=V` }
    }
    const key = pair.slice(0, separatorIndex)
    if (Object.hasOwn(map, key)) {
      return { ok: false, message: `duplicate ${flag} key "${formatReadableField(key)}"` }
    }
    map[key] = pair.slice(separatorIndex + 1)
  }
  return { ok: true, map }
}

type CandidateResult =
  | { readonly ok: true; readonly candidate: Record<string, unknown> }
  | { readonly ok: false; readonly message: string }

/**
 * Assembles the raw record from CLI flags. Every provided flag is included —
 * even ones that do not belong to the chosen transport — so the strict
 * schema reports a precise "unrecognized key" error instead of this function
 * silently dropping, say, `--url` on a stdio server.
 */
function buildCandidate(name: string, values: AddFlagValues): CandidateResult {
  if (values.transport === undefined) {
    return { ok: false, message: '--transport is required (stdio|http)' }
  }
  const env = parseKeyValuePairs(values.env, '--env')
  if (!env.ok) return env
  const headers = parseKeyValuePairs(values.header, '--header')
  if (!headers.ok) return headers

  const candidate: Record<string, unknown> = { name, transport: values.transport }
  if (values.command !== undefined) candidate['command'] = values.command
  if (values.args !== undefined) candidate['args'] = values.args.split(',')
  if (env.map !== undefined) candidate['env'] = env.map
  if (values.url !== undefined) candidate['url'] = values.url
  if (headers.map !== undefined) candidate['headers'] = headers.map
  if (values.protocol !== undefined) candidate['protocol'] = values.protocol
  return { ok: true, candidate }
}

/** Parses `server add` argv into the name positional and flag values; `undefined` on any shape error. */
function parseAddArgs(args: string[]): { name: string; values: AddFlagValues } | undefined {
  try {
    const parsed = parseArgs({
      args: normalizeInlineValues(args),
      options: {
        transport: { type: 'string' },
        command: { type: 'string' },
        args: { type: 'string' },
        env: { type: 'string', multiple: true },
        url: { type: 'string' },
        header: { type: 'string', multiple: true },
        protocol: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    const name = parsed.positionals.length === 1 ? parsed.positionals[0] : undefined
    return name !== undefined ? { name, values: parsed.values } : undefined
  } catch {
    return undefined
  }
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
  return 0
}

/** The command (stdio) or url (http) a record points at, shortened for the list table. */
function listTarget(record: ServerRecord): string {
  const target = record.transport === 'stdio' ? record.command : record.url
  const shortened =
    target.length > MAX_LIST_TARGET_CHARS ? `${target.slice(0, MAX_LIST_TARGET_CHARS)}…` : target
  return formatReadableField(shortened)
}

function formatServerTable(records: readonly ServerRecord[]): string {
  const rows = [
    ['NAME', 'TRANSPORT', 'TARGET'],
    ...records.map((record) => [record.name, record.transport, listTarget(record)]),
  ]
  const widths = [0, 1].map((column) => Math.max(...rows.map((row) => (row[column] ?? '').length)))
  return `${rows
    .map((row) => `${(row[0] ?? '').padEnd(widths[0] ?? 0)}  ${(row[1] ?? '').padEnd(widths[1] ?? 0)}  ${row[2] ?? ''}`)
    .join('\n')}\n`
}

/** `server list`: table of registered servers (name, transport, command/url). */
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
  io.stdout.write(formatServerTable(records))
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
  return 0
}

/**
 * `server remove <name>`. Removes unconditionally: a warning about agent
 * grants still pointing at the server needs `agents.json` (a different Wave 1
 * task) and is wired up in Wave 4.
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

  try {
    const result = await makeStore(opts).removeServer(name)
    if (result.status === 'not-found') {
      io.stderr.write(`unknown server "${formatReadableField(name)}"\n`)
      return 1
    }
    io.stdout.write(`removed server "${result.record.name}"\n`)
    return 0
  } catch (error: unknown) {
    io.stderr.write(`${describeError(error)}\n`)
    return 1
  }
}
