import { formatReadableField } from '../journal/format.js'
import type { JournalSinkOptions } from '../journal/sink.js'
import { SECRET_NAME_PATTERN, VAULT_KEY_FILE_NAME } from '../vault/constants.js'
import {
  createVaultStore,
  type VaultStore,
  type VaultStoreOptions,
} from '../vault/store.js'
import { recordChange, requireOwner } from './vault-cmd-write.js'

/**
 * `vault init|set|list|remove|rekey` — operator CLI over `vault/store.ts`
 * (CliIo pattern, same shape as `policy-cmd.ts`/`quarantine-cmd.ts`).
 *
 * Two deliberate security properties:
 * - `vault set` reads the secret value from STDIN via an injectable reader,
 *   never from argv — argv is visible to every process on the host (`ps`);
 * - there is NO `vault get` and no command ever prints a secret value.
 *   `list` shows names and dates only; values leave the vault exclusively
 *   through `vault/resolve.ts`, in memory, toward an upstream server.
 *
 * Since owner decision S2 (2026-09-03) every MUTATION — `set`, `remove`,
 * `rekey` — needs a personal admin token of role `owner` in `MCP_ADMIN_TOKEN`
 * and is recorded twice: an audit line on stderr and an `access-edit` journal
 * record naming the SECRET, never its value (the gate and the record live in
 * `vault-cmd-write.ts`, shared with `agent *` and `group *`). `init` is the
 * bootstrap that runs before any admin exists and `list` reads; both stay
 * token-free.
 */

const USAGE = `Usage:
  vault init            Create the vault master key (refuses if one exists)
  vault set <name>      Store a secret; the value is read from stdin, not argv
  vault list            List secret names and dates (never values)
  vault remove <name>   Remove a secret
  vault rekey           Rotate the master key and re-encrypt every secret
Every change (set, remove, rekey) needs a personal admin token in MCP_ADMIN_TOKEN (role owner); init and list do not.

There is intentionally no "vault get": secret values never leave the vault
through the CLI. They are resolved in memory for upstream servers only.
`

/** Minimal writable-stream shape these commands need, so tests can inject plain capture objects. */
export interface VaultCliWritable {
  write(chunk: string): unknown
}

export interface VaultCliIo {
  readonly stdout: VaultCliWritable
  readonly stderr: VaultCliWritable
}

/** @internal test-only seams for the journal sink (retry delay, fault-injected commit). */
export interface VaultCliDeps {
  readonly sink?: Pick<JournalSinkOptions, 'retryDelayMs' | 'commitBatchImpl'>
}

export interface VaultCmdDeps {
  /** Overrides the vault directory (and where `state.db`/`journal.db` live). Defaults to `JOURNAL_DIR`. */
  readonly journalDir?: string
  /**
   * Returns the secret value for `vault set`. Defaults to reading all of
   * `process.stdin` (one trailing newline stripped). Injectable so tests
   * never touch the real stdin.
   */
  readonly readSecretInput?: () => Promise<string>
  /** Clock for createdAt/updatedAt — and for the journal record's timestamp. Injectable for tests. */
  readonly now?: () => number
  /** Environment holding `MCP_ADMIN_TOKEN`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  readonly deps?: VaultCliDeps
}

const DEFAULT_IO: VaultCliIo = { stdout: process.stdout, stderr: process.stderr }

/** Dispatches `vault` subcommands. Never throws: all failures resolve to a non-zero exit code. */
export async function runVault(
  args: string[],
  io: VaultCliIo = DEFAULT_IO,
  deps: VaultCmdDeps = {},
): Promise<number> {
  const [subcommand, ...rest] = args
  const store = createVaultStore(storeOptions(deps))
  const readSecretInput = deps.readSecretInput ?? readStdinSecret
  try {
    switch (subcommand) {
      case 'init':
        return await runInit(store, io)
      case 'set':
        return await runSet(store, rest, io, deps, readSecretInput)
      case 'list':
        return await runList(store, io)
      case 'remove':
        return await runRemove(store, rest, io, deps)
      case 'rekey':
        return await runRekey(store, io, deps)
      default:
        io.stderr.write(
          `${subcommand === undefined ? 'Missing subcommand.' : `Unknown subcommand: ${formatReadableField(subcommand)}`}\n\n${USAGE}`,
        )
        return 1
    }
  } catch (error: unknown) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

function storeOptions(deps: VaultCmdDeps): VaultStoreOptions {
  return {
    ...(deps.journalDir !== undefined ? { journalDir: deps.journalDir } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  }
}

async function runInit(store: VaultStore, io: VaultCliIo): Promise<number> {
  const result = await store.init()
  if (result.status === 'initialized') {
    io.stdout.write(`vault initialized: ${result.keyPath}\n`)
    return 0
  }
  if (result.status === 'already-initialized') {
    io.stderr.write(`vault is already initialized ("${result.keyPath}" exists)\n`)
    return 1
  }
  return reportFailure(result, io)
}

async function runSet(
  store: VaultStore,
  rest: string[],
  io: VaultCliIo,
  deps: VaultCmdDeps,
  readSecretInput: () => Promise<string>,
): Promise<number> {
  const name = rest[0]
  if (name === undefined || rest.length > 1) {
    io.stderr.write(USAGE)
    return 1
  }
  // The gate comes BEFORE stdin is read: a refused `set` must not even
  // consume the value — it has no business in this process when nothing
  // will be written.
  const actor = await requireOwner(io, deps)
  if (actor === undefined) return 1
  const value = await readSecretInput()
  if (value.length === 0) {
    io.stderr.write('empty secret value on stdin (pipe the secret in, e.g. `pbpaste | mcpcut vault set <name>`)\n')
    return 1
  }
  const result = await store.setSecret(name, value)
  if (result.status !== 'set') return reportFailure(result, io)
  io.stdout.write(`secret "${result.name}" set\n`)
  return recordChange(io, deps, actor, 'set', formatReadableField(result.name), {
    action: 'vault.set',
    vaultEntry: result.name,
  })
}

async function runList(store: VaultStore, io: VaultCliIo): Promise<number> {
  const result = await store.listSecrets()
  if (result.status !== 'listed') return reportFailure(result, io)
  if (result.secrets.length === 0) {
    io.stdout.write('vault is empty (no secrets)\n')
    return 0
  }
  for (const secret of result.secrets) {
    io.stdout.write(`${secret.name}  created ${secret.createdAt}  updated ${secret.updatedAt}\n`)
  }
  return 0
}

async function runRemove(
  store: VaultStore,
  rest: string[],
  io: VaultCliIo,
  deps: VaultCmdDeps,
): Promise<number> {
  const name = rest[0]
  if (name === undefined || rest.length > 1) {
    io.stderr.write(USAGE)
    return 1
  }
  const actor = await requireOwner(io, deps)
  if (actor === undefined) return 1
  const result = await store.removeSecret(name)
  if (result.status === 'not-found') {
    io.stderr.write(`secret "${result.name}" not found\n`)
    return 1
  }
  if (result.status !== 'removed') return reportFailure(result, io)
  io.stdout.write(`secret "${result.name}" removed\n`)
  return recordChange(io, deps, actor, 'remove', formatReadableField(result.name), {
    action: 'vault.remove',
    vaultEntry: result.name,
  })
}

async function runRekey(store: VaultStore, io: VaultCliIo, deps: VaultCmdDeps): Promise<number> {
  const actor = await requireOwner(io, deps)
  if (actor === undefined) return 1
  const result = await store.rekey()
  if (result.status !== 'rekeyed') return reportFailure(result, io)
  io.stdout.write('vault rekeyed: every secret re-encrypted under a new master key\n')
  // A rekey touches every secret and names none: the fact for the journal is
  // that the master key rotated, so the key file is the audit line's target.
  return recordChange(io, deps, actor, 'rekey', VAULT_KEY_FILE_NAME, { action: 'vault.rekey' })
}

/** Shared rendering for the store's failure union. Always returns 1. */
function reportFailure(
  failure:
    | { readonly status: 'not-initialized' }
    | { readonly status: 'corrupt'; readonly message: string }
    | { readonly status: 'invalid-name'; readonly name: string },
  io: VaultCliIo,
): number {
  switch (failure.status) {
    case 'not-initialized':
      io.stderr.write('vault is not initialized. Run "mcpcut vault init" first.\n')
      return 1
    case 'corrupt':
      io.stderr.write(`vault is corrupt: ${failure.message}\n`)
      return 1
    case 'invalid-name':
      // The name is the operator's own shell input, but still routed through
      // formatReadableField before echoing (same discipline as policy-cmd).
      io.stderr.write(
        `invalid secret name "${formatReadableField(failure.name)}": must match ${SECRET_NAME_PATTERN}\n`,
      )
      return 1
  }
}

/** Default `vault set` value source: all of stdin, one trailing newline stripped. */
async function readStdinSecret(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}
