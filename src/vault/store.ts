import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import {
  decodeVault,
  encodeVault,
  VaultCorruptError,
  type SecretEntry,
  type VaultData,
} from './codec.js'
import {
  SECRET_NAME_PATTERN,
  VAULT_ENC_FILE_NAME,
  VAULT_KEY_FILE_NAME,
  VAULT_KEY_LENGTH_BYTES,
  VAULT_STAGED_KEY_FILE_NAME,
} from './constants.js'
import { generateKey, VaultIntegrityError, VaultKeyError } from './crypto.js'
import {
  decodeBase64Buffer,
  readFileBufferIfExists,
  readFileIfExists,
  renameDurable,
  withVaultLock,
  writeFileAtomic,
} from './files.js'

/**
 * Encrypted secret store (ADR-0003): `vault.key` (base64 master key, 0600) +
 * `vault.enc` (AES-256-GCM envelope over `{[name]: {value, createdAt,
 * updatedAt}}`, 0600). Every public method returns a result union — corruption
 * is loud (`{status: 'corrupt'}`), NEVER silently treated as an empty vault.
 * A missing `vault.enc` next to an existing key IS a valid empty vault; a
 * missing key is `{status: 'not-initialized'}`.
 *
 * Secret values exist in plaintext only inside this process's memory, on the
 * way in (`setSecret`) and out (`readSecretValues` → `resolve.ts`); they are
 * never logged and never returned by `listSecrets`.
 */

/** What `listSecrets` exposes: metadata only, deliberately no `value` field. */
export interface SecretInfo {
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
}

export type VaultFailure =
  | { readonly status: 'not-initialized' }
  | { readonly status: 'corrupt'; readonly message: string }

export type InitVaultResult =
  | { readonly status: 'initialized'; readonly keyPath: string }
  | { readonly status: 'already-initialized'; readonly keyPath: string }
  | VaultFailure

export type SetSecretResult =
  | { readonly status: 'set'; readonly name: string }
  | { readonly status: 'invalid-name'; readonly name: string }
  | VaultFailure

export type ListSecretsResult =
  | { readonly status: 'listed'; readonly secrets: readonly SecretInfo[] }
  | VaultFailure

export type RemoveSecretResult =
  | { readonly status: 'removed'; readonly name: string }
  | { readonly status: 'not-found'; readonly name: string }
  | { readonly status: 'invalid-name'; readonly name: string }
  | VaultFailure

export type ReadSecretValuesResult =
  | { readonly status: 'read'; readonly values: Record<string, string> }
  | VaultFailure

export type RekeyResult = { readonly status: 'rekeyed' } | VaultFailure

export interface VaultStore {
  init(): Promise<InitVaultResult>
  setSecret(name: string, value: string): Promise<SetSecretResult>
  listSecrets(): Promise<ListSecretsResult>
  removeSecret(name: string): Promise<RemoveSecretResult>
  /** Values for the requested names that exist; absent names are simply omitted (resolve.ts reports them). */
  readSecretValues(names: readonly string[]): Promise<ReadSecretValuesResult>
  rekey(): Promise<RekeyResult>
}

export interface VaultStoreOptions {
  /** Directory holding vault.key/vault.enc. Defaults to `JOURNAL_DIR`. */
  readonly journalDir?: string
  /** Clock for createdAt/updatedAt. Defaults to `Date.now`. Injectable for tests. */
  readonly now?: () => number
}

export { VaultCorruptError } from './codec.js'

/** Internal control-flow marker mapped to `{status: 'not-initialized'}`. */
class VaultNotInitializedError extends Error {
  constructor() {
    super('vault is not initialized')
    this.name = 'VaultNotInitializedError'
  }
}

export function createVaultStore(opts: VaultStoreOptions = {}): VaultStore {
  const journalDir = opts.journalDir ?? JOURNAL_DIR
  const now = opts.now ?? Date.now
  const keyPath = join(journalDir, VAULT_KEY_FILE_NAME)
  const encPath = join(journalDir, VAULT_ENC_FILE_NAME)
  const stagedKeyPath = join(journalDir, VAULT_STAGED_KEY_FILE_NAME)
  const lockPath = `${encPath}.lock`

  /** Serializes this instance's operations; `withVaultLock` guards against other processes. */
  let queue: Promise<void> = Promise.resolve()

  function runGuarded<T>(fn: () => Promise<T>): Promise<T | VaultFailure> {
    const task = queue.then(() =>
      withVaultLock(lockPath, async () => {
        try {
          return await fn()
        } catch (error: unknown) {
          return toFailure(error)
        }
      }),
    )
    queue = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  function toFailure(error: unknown): VaultFailure {
    if (error instanceof VaultNotInitializedError) return { status: 'not-initialized' }
    if (
      error instanceof VaultIntegrityError ||
      error instanceof VaultKeyError ||
      error instanceof VaultCorruptError
    ) {
      return { status: 'corrupt', message: error.message }
    }
    throw error // unexpected (fs permissions etc.) — propagate, do not misreport as corruption
  }

  /**
   * Base64-decoded key from `path`, `null` if the file is missing, corrupt
   * error on bad length or non-base64 content. Bytes only end to end: the
   * key never exists as a `string`, which could not be zeroized afterwards.
   */
  async function readKeyFrom(path: string): Promise<Buffer | null> {
    const raw = await readFileBufferIfExists(path)
    if (raw === null) return null
    try {
      const key = decodeBase64Buffer(raw)
      if (key === null || key.length !== VAULT_KEY_LENGTH_BYTES) {
        key?.fill(0)
        throw new VaultCorruptError(
          `vault key file "${path}" is not ${VAULT_KEY_LENGTH_BYTES} bytes of base64`,
        )
      }
      return key
    } finally {
      raw.fill(0)
    }
  }

  async function requireKey(): Promise<Buffer> {
    const key = await readKeyFrom(keyPath)
    if (key === null) throw new VaultNotInitializedError()
    return key
  }

  function decryptData(key: Buffer, text: string): VaultData {
    return decodeVault(key, text, encPath)
  }

  async function writeData(key: Buffer, data: VaultData): Promise<void> {
    await writeFileAtomic(encPath, encodeVault(key, data))
  }

  /**
   * Loads key + data with interrupted-rekey recovery:
   * - primary key decrypts → normal case; a stale staged key (crash after
   *   rekey step 1) is inert — it never became live and is ignored;
   * - primary key FAILS integrity and a staged key exists and decrypts →
   *   crash between rekey steps 2 and 3; finish the rekey by promoting the
   *   staged key, then serve the data;
   * - anything else → the original corruption error (a staged key that does
   *   not decrypt must never mask real corruption or clobber the primary).
   */
  async function loadVault(): Promise<{ key: Buffer; data: VaultData }> {
    const key = await requireKey()
    // `handedOff` means the caller now owns the key and will zeroize it;
    // every other exit from this function — including a throw — must not
    // leave master-key bytes behind in the heap.
    let handedOff = false
    try {
      const text = await readFileIfExists(encPath)
      if (text === null) {
        handedOff = true
        return { key, data: {} } // valid empty vault
      }
      try {
        const data = decryptData(key, text)
        handedOff = true
        return { key, data }
      } catch (error: unknown) {
        if (!(error instanceof VaultIntegrityError)) throw error
        const recovered = await tryStagedRecovery(text)
        if (recovered === null) throw error
        return recovered // the primary key is superseded; zeroized below
      }
    } finally {
      if (!handedOff) key.fill(0)
    }
  }

  async function tryStagedRecovery(text: string): Promise<{ key: Buffer; data: VaultData } | null> {
    let staged: Buffer | null
    try {
      staged = await readKeyFrom(stagedKeyPath)
    } catch {
      return null // corrupt staged key: fall through to the primary failure
    }
    if (staged === null) return null
    let handedOff = false
    try {
      const data = decryptData(staged, text)
      await renameDurable(stagedKeyPath, keyPath) // complete the interrupted rekey (step 3)
      handedOff = true
      return { key: staged, data }
    } catch (error: unknown) {
      if (error instanceof VaultIntegrityError || error instanceof VaultCorruptError) return null
      throw error
    } finally {
      if (!handedOff) staged.fill(0)
    }
  }

  /**
   * Loads the vault, runs `fn`, and zeroizes the master key no matter how
   * `fn` ends. Every public method goes through here: a throw on the way out
   * (a failed write, an unwritable directory) must not be the one path that
   * leaves the key readable in memory.
   */
  async function withVault<T>(fn: (key: Buffer, data: VaultData) => Promise<T>): Promise<T> {
    const { key, data } = await loadVault()
    try {
      return await fn(key, data)
    } finally {
      key.fill(0)
    }
  }

  async function init(): Promise<InitVaultResult> {
    return runGuarded<InitVaultResult>(async () => {
      if ((await readFileIfExists(keyPath)) !== null) {
        return { status: 'already-initialized', keyPath }
      }
      const key = generateKey()
      try {
        await writeFileAtomic(keyPath, `${key.toString('base64')}\n`)
      } finally {
        key.fill(0)
      }
      return { status: 'initialized', keyPath }
    })
  }

  async function setSecret(name: string, value: string): Promise<SetSecretResult> {
    if (!SECRET_NAME_PATTERN.test(name)) return { status: 'invalid-name', name }
    return runGuarded<SetSecretResult>(async () =>
      withVault(async (key, data) => {
        const nowIso = new Date(now()).toISOString()
        const existing = data[name]
        const entry: SecretEntry =
          existing === undefined
            ? { value, createdAt: nowIso, updatedAt: nowIso }
            : { value, createdAt: existing.createdAt, updatedAt: nowIso }
        await writeData(key, { ...data, [name]: entry })
        return { status: 'set', name }
      }),
    )
  }

  async function listSecrets(): Promise<ListSecretsResult> {
    return runGuarded<ListSecretsResult>(async () =>
      withVault(async (_key, data) => {
        const secrets = Object.entries(data)
          .map(([name, entry]) => ({ name, createdAt: entry.createdAt, updatedAt: entry.updatedAt }))
          .sort((a, b) => a.name.localeCompare(b.name))
        return { status: 'listed', secrets }
      }),
    )
  }

  async function removeSecret(name: string): Promise<RemoveSecretResult> {
    if (!SECRET_NAME_PATTERN.test(name)) return { status: 'invalid-name', name }
    return runGuarded<RemoveSecretResult>(async () =>
      withVault(async (key, data) => {
        if (data[name] === undefined) return { status: 'not-found', name }
        const rest = Object.fromEntries(Object.entries(data).filter(([k]) => k !== name))
        await writeData(key, rest)
        return { status: 'removed', name }
      }),
    )
  }

  async function readSecretValues(names: readonly string[]): Promise<ReadSecretValuesResult> {
    return runGuarded<ReadSecretValuesResult>(async () =>
      withVault(async (_key, data) => {
        const values: Record<string, string> = {}
        for (const name of names) {
          const entry = data[name]
          if (entry !== undefined) values[name] = entry.value
        }
        return { status: 'read', values }
      }),
    )
  }

  /**
   * Rekey write-order invariant — no interruption point can lose data:
   *
   *   step 1: stage the NEW key at vault.key.new           (atomic tmp+rename)
   *   step 2: commit vault.enc re-encrypted with that key  (atomic tmp+rename —
   *           this rename is the transaction's commit point)
   *   step 3: promote vault.key.new → vault.key            (atomic rename)
   *
   * Crash after 1: vault.key + vault.enc are still the coherent old
   * generation; the stale staged key is inert (loadVault only consults it
   * when the primary key fails, and only trusts it if it decrypts).
   * Crash after 2: vault.key (old) no longer authenticates vault.enc (new);
   * loadVault detects the integrity failure and completes step 3 itself.
   * Crash after 3: rekey complete.
   *
   * The naive order "replace vault.key first, then vault.enc" is rejected:
   * a crash between the two leaves a key that cannot decrypt the data and no
   * on-disk copy of the old key — unrecoverable loss.
   */
  async function rekey(): Promise<RekeyResult> {
    return runGuarded<RekeyResult>(async () =>
      withVault(async (_oldKey, data) => {
        const newKey = generateKey()
        try {
          await writeFileAtomic(stagedKeyPath, `${newKey.toString('base64')}\n`) // step 1
          await writeData(newKey, data) // step 2 (commit point)
          await renameDurable(stagedKeyPath, keyPath) // step 3
          return { status: 'rekeyed' }
        } finally {
          newKey.fill(0)
        }
      }),
    )
  }

  return { init, setSecret, listSecrets, removeSecret, readSecretValues, rekey }
}
