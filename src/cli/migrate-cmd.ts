import { join } from 'node:path'
import { AGENTS_FILE_NAME } from '../agents/constants.js'
import { createAgentsStore } from '../agents/store.js'
import { ADMINS_FILE_NAME } from '../admin/constants.js'
import { createAdminStore } from '../admin/store.js'
import { JOURNAL_DIR } from '../config.js'
import { migrateLegacyStateFile } from '../policy/store-migrate.js'
import { StoreCorruptError, StoreLockError } from '../policy/store.js'
import { INVENTORY_FILE_NAME, openInventoryStore } from '../policy/inventory-store.js'
import { REGISTRY_FILE_NAME } from '../registry/constants.js'
import { createRegistryStore } from '../registry/store.js'

/**
 * `mcp-journal migrate` — imports legacy `*.json` state (agents, admins,
 * registry, tool inventory) into `state.db`, one line per store. Each import
 * is performed by READING through the document's own domain store, i.e. the
 * same lazy, domain-validated path `createJsonStore` runs on first touch —
 * this command adds only the up-front, per-store report. Running it is never
 * required, but an operator upgrading a fleet wants a single command that
 * reports on every store at once, and a way to migrate state without
 * invoking a command that has other side effects (like `agent list`).
 */

/** Minimal writable-stream shape this command needs, so tests can inject capture objects. */
export interface MigrateCliWritable {
  write(chunk: string): unknown
}

export interface MigrateCliIo {
  readonly stdout: MigrateCliWritable
  readonly stderr: MigrateCliWritable
}

/** Test seam: journal directory override, threaded into every store path. */
export interface MigrateCommandOptions {
  readonly journalDir?: string
}

/**
 * Every state file this command knows how to migrate, in report order, each
 * with the domain-store read that triggers (and domain-validates) its lazy
 * import. Kept to exactly the four M4.5-wave-2 stores (ADR-0006): the
 * approvals queue and the journal itself are later waves and have no legacy
 * `*.json` to import.
 */
const STATE_FILES: ReadonlyArray<{
  readonly fileName: string
  readonly importDocument: (journalDir: string) => Promise<void>
}> = [
  {
    fileName: AGENTS_FILE_NAME,
    importDocument: async (journalDir) => {
      await createAgentsStore({ journalDir }).listAgents()
    },
  },
  {
    fileName: ADMINS_FILE_NAME,
    importDocument: async (journalDir) => {
      await createAdminStore({ journalDir }).listAdmins()
    },
  },
  {
    fileName: REGISTRY_FILE_NAME,
    importDocument: async (journalDir) => {
      await createRegistryStore(journalDir).listServers()
    },
  },
  {
    fileName: INVENTORY_FILE_NAME,
    importDocument: async (journalDir) => {
      await openInventoryStore(join(journalDir, INVENTORY_FILE_NAME)).read()
    },
  },
]

const STATUS_LABELS = {
  imported: 'imported',
  'already-migrated': 'already migrated',
  native: 'created in state.db (no legacy import)',
  'no-file': 'no file',
} as const

/** Errors this command converts into an exit-1 message instead of a crash. */
const EXPECTED_ERRORS = [StoreCorruptError, StoreLockError] as const

function isExpectedError(error: unknown): error is Error {
  return EXPECTED_ERRORS.some((kind) => error instanceof kind)
}

/**
 * Dispatches `migrate` (no subcommands or flags). Returns a process exit
 * code; only unexpected (programming/filesystem) errors propagate as
 * rejections.
 *
 * Stops at the FIRST corrupt or locked store rather than trying the rest:
 * a store already reported before the failure keeps its line (that report
 * was true), but the run withholds the closing summary line, so a reader can
 * never mistake a halted run for a complete one.
 */
export async function runMigrateCommand(
  args: readonly string[],
  io: MigrateCliIo,
  opts: MigrateCommandOptions = {},
): Promise<number> {
  if (args.length > 0) {
    // Silently ignoring arguments would run a real migration when the
    // operator asked for something else (`migrate --help`, a stray path).
    io.stderr.write(`migrate takes no arguments (got: ${args.join(' ')})\n`)
    return 1
  }

  const journalDir = opts.journalDir ?? JOURNAL_DIR
  let importedCount = 0

  try {
    for (const { fileName, importDocument } of STATE_FILES) {
      const filePath = join(journalDir, fileName)
      const status = await migrateLegacyStateFile(filePath, () => importDocument(journalDir))
      io.stdout.write(`state: ${fileName} -> ${STATUS_LABELS[status]}\n`)
      if (status === 'imported') importedCount += 1
    }
  } catch (error: unknown) {
    if (isExpectedError(error)) {
      io.stderr.write(`${error.message}\n`)
      return 1
    }
    throw error
  }

  io.stdout.write(`Migrated ${importedCount} store(s) into state.db.\n`)
  return 0
}
