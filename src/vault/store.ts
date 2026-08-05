import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { JOURNAL_DIR } from '../config.js'
import {
  SECRET_NAME_PATTERN,
  VAULT_ENC_FILE_NAME,
  VAULT_FORMAT_VERSION,
  VAULT_KEY_FILE_NAME,
  VAULT_KEY_LENGTH_BYTES,
  VAULT_STAGED_KEY_FILE_NAME,
} from './constants.js'
import {
  decrypt,
  encrypt,
  generateKey,
  VaultIntegrityError,
  VaultKeyError,
  type EncryptedPayload,
} from './crypto.js'
import { readFileIfExists, withVaultLock, writeFileAtomic } from './files.js'

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

/** vault.enc's JSON envelope: `data` is the AES-256-GCM ciphertext of the secrets JSON. */
const envelopeSchema = z.strictObject({
  v: z.literal(VAULT_FORMAT_VERSION),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
})

const entrySchema = z.strictObject({
  value: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const dataSchema = z.record(z.string().regex(SECRET_NAME_PATTERN), entrySchema)

type SecretEntry = z.infer<typeof entrySchema>
type VaultData = Record<string, SecretEntry>

/** vault.enc or vault.key exists but cannot be trusted (bad JSON/shape/length). */
export class VaultCorruptError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'VaultCorruptError'
  }
}

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

  /** Base64-decoded key from `path`, `null` if the file is missing, corrupt error on bad length. */
  async function readKeyFrom(path: string): Promise<Buffer | null> {
    const raw = await readFileIfExists(path)
    if (raw === null) return null
    const key = Buffer.from(raw.trim(), 'base64')
    if (key.length !== VAULT_KEY_LENGTH_BYTES) {
      throw new VaultCorruptError(
        `vault key file "${path}" is not ${VAULT_KEY_LENGTH_BYTES} bytes of base64`,
      )
    }
    return key
  }

  async function requireKey(): Promise<Buffer> {
    const key = await readKeyFrom(keyPath)
    if (key === null) throw new VaultNotInitializedError()
    return key
  }

  function parseEnvelope(text: string): EncryptedPayload {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error: unknown) {
      throw new VaultCorruptError(`vault store "${encPath}" is not valid JSON (truncated?)`, error)
    }
    const parsed = envelopeSchema.safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => issue.message).join('; ')
      throw new VaultCorruptError(`vault store "${encPath}" has an invalid envelope: ${issues}`)
    }
    return {
      iv: Buffer.from(parsed.data.iv, 'base64'),
      tag: Buffer.from(parsed.data.tag, 'base64'),
      data: Buffer.from(parsed.data.data, 'base64'),
    }
  }

  /** Decrypts and validates the secrets JSON; zeroizes the plaintext buffer after parsing. */
  function decryptData(key: Buffer, text: string): VaultData {
    const plaintext = decrypt(key, parseEnvelope(text))
    let raw: unknown
    try {
      raw = JSON.parse(plaintext.toString('utf8'))
    } catch (error: unknown) {
      throw new VaultCorruptError('vault plaintext is not valid JSON', error)
    } finally {
      plaintext.fill(0)
    }
    const parsed = dataSchema.safeParse(raw)
    if (!parsed.success) throw new VaultCorruptError('vault plaintext has an invalid shape')
    return parsed.data
  }

  async function writeData(key: Buffer, data: VaultData): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(data), 'utf8')
    const payload = encrypt(key, plaintext)
    plaintext.fill(0)
    const envelope = {
      v: VAULT_FORMAT_VERSION,
      iv: payload.iv.toString('base64'),
      tag: payload.tag.toString('base64'),
      data: payload.data.toString('base64'),
    }
    await writeFileAtomic(encPath, JSON.stringify(envelope))
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
    const text = await readFileIfExists(encPath)
    if (text === null) return { key, data: {} } // valid empty vault
    try {
      return { key, data: decryptData(key, text) }
    } catch (error: unknown) {
      if (!(error instanceof VaultIntegrityError)) throw error
      const recovered = await tryStagedRecovery(text)
      if (recovered === null) throw error
      key.fill(0)
      return recovered
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
    try {
      const data = decryptData(staged, text)
      await rename(stagedKeyPath, keyPath) // complete the interrupted rekey (step 3)
      return { key: staged, data }
    } catch (error: unknown) {
      if (error instanceof VaultIntegrityError || error instanceof VaultCorruptError) return null
      throw error
    }
  }

  async function init(): Promise<InitVaultResult> {
    return runGuarded<InitVaultResult>(async () => {
      if ((await readFileIfExists(keyPath)) !== null) {
        return { status: 'already-initialized', keyPath }
      }
      const key = generateKey()
      await writeFileAtomic(keyPath, `${key.toString('base64')}\n`)
      key.fill(0)
      return { status: 'initialized', keyPath }
    })
  }

  async function setSecret(name: string, value: string): Promise<SetSecretResult> {
    if (!SECRET_NAME_PATTERN.test(name)) return { status: 'invalid-name', name }
    return runGuarded<SetSecretResult>(async () => {
      const { key, data } = await loadVault()
      const nowIso = new Date(now()).toISOString()
      const existing = data[name]
      const entry: SecretEntry =
        existing === undefined
          ? { value, createdAt: nowIso, updatedAt: nowIso }
          : { value, createdAt: existing.createdAt, updatedAt: nowIso }
      await writeData(key, { ...data, [name]: entry })
      key.fill(0)
      return { status: 'set', name }
    })
  }

  async function listSecrets(): Promise<ListSecretsResult> {
    return runGuarded<ListSecretsResult>(async () => {
      const { key, data } = await loadVault()
      key.fill(0)
      const secrets = Object.entries(data)
        .map(([name, entry]) => ({ name, createdAt: entry.createdAt, updatedAt: entry.updatedAt }))
        .sort((a, b) => a.name.localeCompare(b.name))
      return { status: 'listed', secrets }
    })
  }

  async function removeSecret(name: string): Promise<RemoveSecretResult> {
    if (!SECRET_NAME_PATTERN.test(name)) return { status: 'invalid-name', name }
    return runGuarded<RemoveSecretResult>(async () => {
      const { key, data } = await loadVault()
      if (data[name] === undefined) {
        key.fill(0)
        return { status: 'not-found', name }
      }
      const rest = Object.fromEntries(Object.entries(data).filter(([k]) => k !== name))
      await writeData(key, rest)
      key.fill(0)
      return { status: 'removed', name }
    })
  }

  async function readSecretValues(names: readonly string[]): Promise<ReadSecretValuesResult> {
    return runGuarded<ReadSecretValuesResult>(async () => {
      const { key, data } = await loadVault()
      key.fill(0)
      const values: Record<string, string> = {}
      for (const name of names) {
        const entry = data[name]
        if (entry !== undefined) values[name] = entry.value
      }
      return { status: 'read', values }
    })
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
    return runGuarded<RekeyResult>(async () => {
      const { key: oldKey, data } = await loadVault()
      oldKey.fill(0)
      const newKey = generateKey()
      await writeFileAtomic(stagedKeyPath, `${newKey.toString('base64')}\n`) // step 1
      await writeData(newKey, data) // step 2 (commit point)
      await rename(stagedKeyPath, keyPath) // step 3
      newKey.fill(0)
      return { status: 'rekeyed' }
    })
  }

  return { init, setSecret, listSecrets, removeSecret, readSecretValues, rekey }
}
