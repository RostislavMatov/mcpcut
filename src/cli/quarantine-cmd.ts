import { dirname, join } from 'node:path'
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
import { openInventoryStore, type InventoryStoreData } from '../policy/inventory-store.js'
import { StoreCorruptError, StoreLockError } from '../policy/store.js'
import {
  recordQuarantineResolution,
  requireQuarantineAdmin,
} from './quarantine-cmd-write.js'
import { formatQuarantineShow } from './quarantine-show-format.js'

/**
 * `quarantine list|approve|reject` -- CLI review queue for tools that are
 * new or whose schema changed since approval ("rug pull" defense; see
 * `policy/inventory.ts`). Every field printed here that originates from a
 * journal-owned store file is untrusted (a compromised/malicious MCP server
 * controls tool names and descriptions) and is routed through
 * `formatReadableField` before it reaches the terminal, exactly like the
 * journal-readable view in `cli.ts`.
 *
 * Since owner decision Q17 (2026-09-08) the three MUTATING forms — `approve`,
 * `approve --all`, `reject` — need a personal admin token of role `operator`
 * in `MCP_ADMIN_TOKEN` (the threshold the admin UI's own route carries) and
 * each release is recorded twice: an audit line on stderr and an `access-edit`
 * journal record naming the server, the tool and the admin. The gate and the
 * record live in `quarantine-cmd-write.ts`, shared with `agent *`, `group *`
 * and `vault *`. `list` and `show` stay token-free.
 */

const USAGE = `Usage:
  quarantine list [--server <name>] [--json]       List quarantined tools
  quarantine show <server> <tool>                   Show the structural inputSchema diff for a quarantined tool
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
  /**
   * Directory holding `state.db` (the admin store the token is resolved
   * against) and `journal.db` (where the release is recorded).
   *
   * Defaults to the directory the inventory store itself lives in, which IS
   * the journal directory in production (`resolveStorePath` joins
   * `INVENTORY_FILE_NAME` onto `JOURNAL_DIR`) and in every caller that
   * isolates this command on a temp directory. Naming it explicitly is still
   * supported, and is what a caller with an inventory outside the journal
   * directory must do.
   */
  readonly journalDir?: string
  /** Environment holding `MCP_ADMIN_TOKEN`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
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
      case 'show':
        return await runShow(rest, io, opts.storePath)
      case 'approve':
        return await runApprove(rest, io, resolveOptions(opts))
      case 'reject':
        return await runReject(rest, io, resolveOptions(opts))
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

/**
 * `quarantine show <server> <tool>` -- CLI parity for the admin UI's
 * quarantine card (`src/ui/pages/quarantine.ts`): same structural
 * `inputSchema` diff, same `surfaceDelta` verdict, so an operator without a
 * browser does not lose functionality. Reuses `diffToolSchemas` (the pure
 * diff from `policy/schema-diff.ts`) rather than reimplementing it -- this
 * command only formats what the diff and the store already compute.
 */
async function runShow(subArgs: string[], io: QuarantineCliIo, storePath: string | undefined): Promise<number> {
  const { positionals } = parseArgs({ args: subArgs, options: {}, allowPositionals: true })

  const [server, tool] = positionals
  if (server === undefined || tool === undefined) {
    io.stderr.write(`Usage: quarantine show <server> <tool>\n\n${USAGE}`)
    return 1
  }

  const store = openInventoryStore(resolveStorePath(storePath))
  const data = await store.read()
  const quarantined = data.servers[server]?.quarantined[tool]
  if (quarantined === undefined) {
    io.stderr.write(`"${tool}" is not quarantined for server "${server}".\n`)
    return 1
  }

  const approvedDescriptor = data.servers[server]?.approved[tool]?.descriptor
  io.stdout.write(formatQuarantineShow(server, tool, quarantined, approvedDescriptor))
  return 0
}

async function runApprove(
  subArgs: string[],
  io: QuarantineCliIo,
  opts: RunQuarantineOptions,
): Promise<number> {
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
    return approveAllForServer(values.server, io, opts)
  }

  const [server, tool] = positionals
  if (server === undefined || tool === undefined) {
    io.stderr.write(`Usage: quarantine approve <server> <tool>\n\n${USAGE}`)
    return 1
  }

  // The gate comes BEFORE the store is touched (Q17): a refused release must
  // leave the quarantine exactly as it found it.
  const actor = await requireQuarantineAdmin(io, opts)
  if (actor === undefined) return 1

  const approved = await approveTool(server, tool, opts.storePath)
  if (!approved) {
    io.stderr.write(`"${tool}" is not quarantined for server "${server}".\n`)
    return 1
  }
  io.stdout.write(`Approved "${tool}" for server "${server}".\n`)
  return recordQuarantineResolution(io, opts, actor, 'approve', server, tool)
}

async function approveAllForServer(
  server: string,
  io: QuarantineCliIo,
  opts: RunQuarantineOptions,
): Promise<number> {
  const actor = await requireQuarantineAdmin(io, opts)
  if (actor === undefined) return 1

  const all = await listAllQuarantined(opts.storePath)
  const forServer = all.filter((entry) => entry.serverName === server)

  if (forServer.length === 0) {
    io.stdout.write(`No quarantined tools for server "${server}".\n`)
    return 0
  }

  // One record per tool, not one per command: an auditor asking who released
  // THIS tool must get an answer that names it.
  for (const entry of forServer) {
    await approveTool(entry.serverName, entry.toolName, opts.storePath)
    io.stdout.write(`Approved "${entry.toolName}" for server "${entry.serverName}".\n`)
    await recordQuarantineResolution(io, opts, actor, 'approve', entry.serverName, entry.toolName)
  }
  return 0
}

async function runReject(
  subArgs: string[],
  io: QuarantineCliIo,
  opts: RunQuarantineOptions,
): Promise<number> {
  const { positionals } = parseArgs({ args: subArgs, options: {}, allowPositionals: true })

  const [server, tool] = positionals
  if (server === undefined || tool === undefined) {
    io.stderr.write(`Usage: quarantine reject <server> <tool>\n\n${USAGE}`)
    return 1
  }

  const actor = await requireQuarantineAdmin(io, opts)
  if (actor === undefined) return 1

  const rejected = await rejectTool(server, tool, opts.storePath)
  if (!rejected) {
    io.stderr.write(`"${tool}" is not quarantined for server "${server}".\n`)
    return 1
  }
  io.stdout.write(`Rejected "${tool}" for server "${server}".\n`)
  return recordQuarantineResolution(io, opts, actor, 'reject', server, tool)
}

/**
 * The caller's options with `journalDir` filled in from where the inventory
 * store lives, so a caller that isolated this command on a temp directory by
 * `storePath` alone does not resolve the token against the real installation.
 */
function resolveOptions(opts: RunQuarantineOptions): RunQuarantineOptions {
  if (opts.journalDir !== undefined) return opts
  return { ...opts, journalDir: dirname(resolveStorePath(opts.storePath)) }
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
// `QuarantinedEntry` with no descriptor, so this CLI opens the inventory
// store a second time to recover the pending (currently quarantined)
// description for the "changed" hint above. It goes through the store seam
// rather than reading a file directly: since M4.5 the state lives in
// `state.db`, and a raw read of the legacy `*.json` path would silently
// return nothing. This is best-effort display only: a corrupt or contended
// store costs the hint, not the whole `list` command, since
// `listAllQuarantined` already performed the authoritative, validated read
// moments earlier.

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

  let data: InventoryStoreData
  try {
    data = await openInventoryStore(storePath).read()
  } catch (error: unknown) {
    // Same graceful degradation as `policy/inventory.ts`: an unreadable store
    // is already reported by the authoritative read, so drop the hint instead
    // of failing `list`. Anything else is unexpected and stays loud.
    if (error instanceof StoreCorruptError || error instanceof StoreLockError) return descriptions
    throw error
  }

  for (const [serverName, serverEntry] of Object.entries(data.servers)) {
    for (const [toolName, record] of Object.entries(serverEntry.quarantined)) {
      const { description } = record.descriptor
      if (description !== undefined) {
        descriptions.set(descriptionKey(serverName, toolName), description)
      }
    }
  }
  return descriptions
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
