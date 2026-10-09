import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import { FILES_SERVER_NAME } from '../files/constants.js'
import { listedTools } from '../files/tools.js'
import { formatReadableField } from '../journal/format.js'
import { INVENTORY_FILE_NAME, approveCatalog } from '../policy/inventory.js'
import { StoreCorruptError, StoreLockError } from '../policy/store.js'
import type { ToolDescriptor } from '../protocol/mcp.js'
import { DuplicateServerError } from '../registry/store.js'
import type { RegistryStore } from '../registry/store.js'
import { auditLineOf, pairTarget, recordAccessChange, type AccessWriteIo, type AccessWriteOptions } from './access-cmd-write.js'
import type { RequiredAdmin } from './admin-token.js'
import { cliCommand } from './next-step.js'

/**
 * The registry side of `mcpcut files` (ADR-0020 §1): the file module is the
 * built-in server named `files`. `root add` makes sure it is registered and
 * that its tools are confirmed in the quarantine inventory; `grant` needs it.
 * A server of another kind under that name is a conflict the admin resolves,
 * never overwritten.
 */

type RegistryReader = Pick<RegistryStore, 'getServer'>
type RegistryWriter = Pick<RegistryStore, 'getServer' | 'addServer'>

export type FilesServerState = 'builtin' | 'missing' | 'conflict'

export async function filesServerState(registry: RegistryReader): Promise<FilesServerState> {
  const record = await registry.getServer(FILES_SERVER_NAME)
  if (record === undefined) return 'missing'
  return record.transport === 'builtin' ? 'builtin' : 'conflict'
}

/** One line: another server holds the name, here is how to free it. */
export function conflictMessage(env: NodeJS.ProcessEnv | undefined): string {
  return (
    `a server named "${formatReadableField(FILES_SERVER_NAME)}" is already registered and is not the built-in file server: ` +
    `remove it with \`${cliCommand(env)} server remove ${FILES_SERVER_NAME}\`, then run this again`
  )
}

/** One line: the built-in server is not registered; `root add` registers it. */
export function notRegisteredMessage(env: NodeJS.ProcessEnv | undefined, folder: string): string {
  return `the built-in file server is not registered yet: run \`${cliCommand(env)} files root add ${folder}\` first`
}

/** Registers the built-in `files` server when absent; `added` says whether this call did it. */
export async function registerFilesServer(registry: RegistryWriter): Promise<{ readonly added: boolean }> {
  if ((await filesServerState(registry)) === 'builtin') return { added: false }
  try {
    await registry.addServer({ name: FILES_SERVER_NAME, transport: 'builtin', kind: 'files' })
    return { added: true }
  } catch (error: unknown) {
    // A concurrent `root add` registered it between our read and our write.
    if (error instanceof DuplicateServerError && (await filesServerState(registry)) === 'builtin') return { added: false }
    throw error
  }
}

/** Every tool the built-in server can list (`search_files` included), as the gate parses it off the wire. */
function builtinCatalog(): readonly ToolDescriptor[] {
  return JSON.parse(JSON.stringify(listedTools({ isSearchListed: true }))) as ToolDescriptor[]
}

export type ConfirmFilesToolsResult =
  | { readonly ok: true; readonly tools: readonly string[] }
  | { readonly ok: false; readonly message: string }

/**
 * Confirms the built-in server's tools in the quarantine inventory (owner's
 * decision, 2026-10-09): they are mcpcut's own code, so the agent's first
 * `list_roots` must not wait for a person. `tools` are the ones this call
 * confirmed — none when they already were, the changed ones after an
 * upgrade. Another server's quarantine is never touched. A corrupt or busy
 * store is one line naming `retry`, the command to run once it is fixed.
 */
export async function confirmFilesTools(journalDir: string | undefined, retry: string): Promise<ConfirmFilesToolsResult> {
  try {
    return { ok: true, tools: await approveCatalog(FILES_SERVER_NAME, builtinCatalog(), join(journalDir ?? JOURNAL_DIR, INVENTORY_FILE_NAME)) }
  } catch (error: unknown) {
    if (!(error instanceof StoreCorruptError || error instanceof StoreLockError)) throw error
    return { ok: false, message: `${error.message}. The folder was not added: once the store is repaired or free, run \`${retry}\` again` }
  }
}

/**
 * One audit line for the batch, and one `quarantine.approve` record per tool —
 * the record `quarantine approve --all` writes, so "who released this tool"
 * names the tool and the admin whichever command released it.
 */
export async function recordConfirmedTools(
  io: AccessWriteIo,
  opts: AccessWriteOptions,
  actor: RequiredAdmin,
  tools: readonly string[],
): Promise<void> {
  if (tools.length === 0) return
  io.stderr.write(auditLineOf('quarantine', 'approve', actor, `${FILES_SERVER_NAME} (${tools.length} built-in tools)`))
  for (const tool of tools) {
    await recordAccessChange({
      io,
      opts,
      actor,
      subject: 'quarantine',
      op: 'approve',
      target: pairTarget(FILES_SERVER_NAME, tool),
      info: { action: 'quarantine.approve', server: FILES_SERVER_NAME, tool },
      isAuditLineShown: false,
    })
  }
}
