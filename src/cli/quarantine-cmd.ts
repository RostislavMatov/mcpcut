import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { JOURNAL_DIR } from '../config.js'
import { formatReadableField } from '../journal/format.js'
import {
  approveTool,
  INVENTORY_FILE_NAME,
  listAllQuarantined,
  rejectTool,
  type QuarantinedEntry,
} from '../policy/inventory.js'

/**
 * `quarantine list|approve|reject` -- CLI review queue for tools that are
 * new or whose schema changed since approval ("rug pull" defense; see
 * `policy/inventory.ts`). Every field printed here that originates from a
 * journal-owned store file is untrusted (a compromised/malicious MCP server
 * controls tool names and descriptions) and is routed through
 * `formatReadableField` before it reaches the terminal, exactly like the
 * journal-readable view in `cli.ts`.
 */

const USAGE = `Usage:
  quarantine list [--server <name>] [--json]       List quarantined tools
  quarantine approve <server> <tool>                Approve a quarantined tool
  quarantine approve --all --server <name>          Approve every quarantined tool for a server
  quarantine reject <server> <tool>                 Reject (discard) a quarantined tool
`

/** Minimal writable-stream shape `runQuarantine` needs, so tests can inject plain capture objects. */
export interface QuarantineCliWritable {
  write(text: string): unknown
}

export interface QuarantineCliIo {
  readonly stdout: QuarantineCliWritable
  readonly stderr: QuarantineCliWritable
}

export interface RunQuarantineOptions {
  /** Overrides the inventory store path. Defaults to `JOURNAL_DIR/tool-inventory.json`, mirroring `policy/inventory.ts`. */
  readonly storePath?: string
}

const DEFAULT_IO: QuarantineCliIo = { stdout: process.stdout, stderr: process.stderr }

/** Dispatches `quarantine list|approve|reject` subcommands. Never throws: all failures resolve to a non-zero exit code. */
export async function runQuarantine(
  args: string[],
  io: QuarantineCliIo = DEFAULT_IO,
  opts: RunQuarantineOptions = {},
): Promise<number> {
  const [subcommand, ...rest] = args
  try {
    switch (subcommand) {
      case 'list':
        return await runList(rest, io, opts.storePath)
      case 'approve':
        return await runApprove(rest, io, opts.storePath)
      case 'reject':
        return await runReject(rest, io, opts.storePath)
      default:
        io.stderr.write(
          `${subcommand === undefined ? 'Missing subcommand.' : `Unknown subcommand: ${subcommand}`}\n\n${USAGE}`,
        )
        return 1
    }
  } catch (error: unknown) {
    io.stderr.write(`${errorMessage(error)}\n\n${USAGE}`)
    return 1
  }
}

async function runList(subArgs: string[], io: QuarantineCliIo, storePath: string | undefined): Promise<number> {
  const { values } = parseArgs({
    args: subArgs,
    options: { server: { type: 'string' }, json: { type: 'boolean', default: false } },
    allowPositionals: false,
  })

  const all = await listAllQuarantined(storePath)
  const filtered = values.server === undefined ? all : all.filter((entry) => entry.serverName === values.server)

  if (filtered.length === 0) {
    io.stdout.write('no quarantined tools\n')
    return 0
  }

  const descriptions = await readPendingDescriptions(resolveStorePath(storePath))
  io.stdout.write(
    values.json === true
      ? formatQuarantineJson(filtered, descriptions)
      : formatQuarantineTable(filtered, descriptions),
  )
  return 0
}

async function runApprove(subArgs: string[], io: QuarantineCliIo, storePath: string | undefined): Promise<number> {
  const { values, positionals } = parseArgs({
    args: subArgs,
    options: { all: { type: 'boolean', default: false }, server: { type: 'string' } },
    allowPositionals: true,
  })

  if (values.all === true) {
    if (values.server === undefined) {
      io.stderr.write(`"approve --all" requires "--server <name>".\n\n${USAGE}`)
      return 1
    }
    return approveAllForServer(values.server, io, storePath)
  }

  const [server, tool] = positionals
  if (server === undefined || tool === undefined) {
    io.stderr.write(`Usage: quarantine approve <server> <tool>\n\n${USAGE}`)
    return 1
  }

  const approved = await approveTool(server, tool, storePath)
  if (!approved) {
    io.stderr.write(`"${tool}" is not quarantined for server "${server}".\n`)
    return 1
  }
  io.stdout.write(`Approved "${tool}" for server "${server}".\n`)
  return 0
}

async function approveAllForServer(
  server: string,
  io: QuarantineCliIo,
  storePath: string | undefined,
): Promise<number> {
  const all = await listAllQuarantined(storePath)
  const forServer = all.filter((entry) => entry.serverName === server)

  if (forServer.length === 0) {
    io.stdout.write(`No quarantined tools for server "${server}".\n`)
    return 0
  }

  for (const entry of forServer) {
    await approveTool(entry.serverName, entry.toolName, storePath)
    io.stdout.write(`Approved "${entry.toolName}" for server "${entry.serverName}".\n`)
  }
  return 0
}

async function runReject(subArgs: string[], io: QuarantineCliIo, storePath: string | undefined): Promise<number> {
  const { positionals } = parseArgs({ args: subArgs, options: {}, allowPositionals: true })

  const [server, tool] = positionals
  if (server === undefined || tool === undefined) {
    io.stderr.write(`Usage: quarantine reject <server> <tool>\n\n${USAGE}`)
    return 1
  }

  const rejected = await rejectTool(server, tool, storePath)
  if (!rejected) {
    io.stderr.write(`"${tool}" is not quarantined for server "${server}".\n`)
    return 1
  }
  io.stdout.write(`Rejected "${tool}" for server "${server}".\n`)
  return 0
}

// -- formatting ----------------------------------------------------------

function formatQuarantineTable(
  entries: readonly QuarantinedEntry[],
  descriptions: ReadonlyMap<string, string>,
): string {
  const header = `${'server'.padEnd(20)}  ${'tool'.padEnd(24)}  ${'state'.padEnd(8)}  ${'firstSeenAt'.padEnd(24)}  hash\n`
  return header + entries.map((entry) => formatQuarantineLine(entry, descriptions)).join('')
}

/** Every field on `entry` is read back from the inventory store file -- untrusted, see module doc comment. */
function formatQuarantineLine(entry: QuarantinedEntry, descriptions: ReadonlyMap<string, string>): string {
  const server = formatReadableField(entry.serverName)
  const tool = formatReadableField(entry.toolName)
  const state = formatReadableField(entry.state)
  const firstSeenAt = formatReadableField(entry.firstSeenAt)
  const hash = formatReadableField(entry.shortHash)
  const line = `${server.padEnd(20)}  ${tool.padEnd(24)}  ${state.padEnd(8)}  ${firstSeenAt.padEnd(24)}  ${hash}\n`

  if (entry.state !== 'changed') return line
  const pendingDescription = descriptions.get(descriptionKey(entry.serverName, entry.toolName))
  if (pendingDescription === undefined) return line

  // LIMITATION: the approved catalog (`policy/inventory.ts`) only stores a
  // schema hash for each approved tool, not its previous description, so we
  // cannot render a real before/after diff here -- only the pending
  // (currently quarantined) description is available. `formatReadableField`
  // both neutralizes control characters and caps the length (~200 chars),
  // since a malicious server can advertise an arbitrarily large or
  // terminal-hostile description.
  return `${line}    description now: "${formatReadableField(pendingDescription)}" (changed since last approval; previous description not retained)\n`
}

function formatQuarantineJson(
  entries: readonly QuarantinedEntry[],
  descriptions: ReadonlyMap<string, string>,
): string {
  return entries.map((entry) => JSON.stringify(toJsonEntry(entry, descriptions))).join('\n') + '\n'
}

interface QuarantineJsonEntry extends QuarantinedEntry {
  readonly pendingDescription?: string
}

function toJsonEntry(entry: QuarantinedEntry, descriptions: ReadonlyMap<string, string>): QuarantineJsonEntry {
  if (entry.state !== 'changed') return entry
  const pendingDescription = descriptions.get(descriptionKey(entry.serverName, entry.toolName))
  return pendingDescription === undefined ? entry : { ...entry, pendingDescription }
}

// -- pending description lookup ------------------------------------------
//
// `listAllQuarantined` (policy/inventory.ts) intentionally returns a flat
// `QuarantinedEntry` with no descriptor, so this CLI reads the store file's
// raw JSON itself to recover the pending (currently quarantined)
// description for the "changed" hint above. This is best-effort display
// only: any read/parse failure here silently yields no descriptions rather
// than failing the whole `list` command, since `listAllQuarantined` already
// performed the authoritative, validated read moments earlier.

interface RawQuarantinedRecord {
  readonly descriptor?: { readonly description?: unknown }
}

interface RawServerInventory {
  readonly quarantined?: Readonly<Record<string, RawQuarantinedRecord>>
}

interface RawInventoryFile {
  readonly servers?: Readonly<Record<string, RawServerInventory>>
}

/** Composite-key separator for `descriptions`. Collision would require a server or tool name literally containing "::", which is not a valid MCP tool identifier shape in practice; a false match only affects this best-effort display hint, never approve/reject. */
const DESCRIPTION_KEY_SEPARATOR = '::'

function descriptionKey(serverName: string, toolName: string): string {
  return `${serverName}${DESCRIPTION_KEY_SEPARATOR}${toolName}`
}

function resolveStorePath(storePath: string | undefined): string {
  return storePath ?? join(JOURNAL_DIR, INVENTORY_FILE_NAME)
}

async function readPendingDescriptions(storePath: string): Promise<Map<string, string>> {
  const descriptions = new Map<string, string>()
  let parsed: RawInventoryFile
  try {
    parsed = JSON.parse(await readFile(storePath, 'utf8')) as RawInventoryFile
  } catch {
    return descriptions
  }

  for (const [serverName, serverEntry] of Object.entries(parsed.servers ?? {})) {
    for (const [toolName, record] of Object.entries(serverEntry.quarantined ?? {})) {
      const description = record.descriptor?.description
      if (typeof description === 'string') {
        descriptions.set(descriptionKey(serverName, toolName), description)
      }
    }
  }
  return descriptions
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
