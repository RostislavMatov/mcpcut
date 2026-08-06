import { z } from 'zod'
import { SECRET_NAME_PATTERN, VAULT_FORMAT_VERSION } from './constants.js'
import { decrypt, encrypt, type EncryptedPayload } from './crypto.js'

/**
 * On-disk representation of `vault.enc` (ADR-0003): the JSON envelope, its
 * schema, and the encode/decode pair that turns a master key plus a secrets
 * map into that envelope and back.
 *
 * Split out of `store.ts` so the store is left with what it is actually
 * about — key lifetime, the lock, the rekey write-order invariant — and the
 * format lives in one auditable place. Nothing here touches the filesystem;
 * corruption is always a typed `VaultCorruptError`, never a silent empty
 * vault.
 */

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

export type SecretEntry = z.infer<typeof entrySchema>
export type VaultData = Record<string, SecretEntry>

/** vault.enc or vault.key exists but cannot be trusted (bad JSON/shape/length). */
export class VaultCorruptError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'VaultCorruptError'
  }
}

function parseEnvelope(text: string, sourcePath: string): EncryptedPayload {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error: unknown) {
    throw new VaultCorruptError(`vault store "${sourcePath}" is not valid JSON (truncated?)`, error)
  }
  const parsed = envelopeSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message).join('; ')
    throw new VaultCorruptError(`vault store "${sourcePath}" has an invalid envelope: ${issues}`)
  }
  return {
    iv: Buffer.from(parsed.data.iv, 'base64'),
    tag: Buffer.from(parsed.data.tag, 'base64'),
    data: Buffer.from(parsed.data.data, 'base64'),
  }
}

/**
 * Decrypts and validates the secrets JSON, zeroizing the plaintext buffer
 * once it has been parsed. A tag mismatch surfaces as the crypto layer's
 * `VaultIntegrityError` (the caller distinguishes it: it is what triggers
 * interrupted-rekey recovery), anything else as `VaultCorruptError`.
 */
export function decodeVault(key: Buffer, text: string, sourcePath: string): VaultData {
  const plaintext = decrypt(key, parseEnvelope(text, sourcePath))
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

/** Serializes and encrypts the secrets map into a ready-to-write envelope. */
export function encodeVault(key: Buffer, data: VaultData): string {
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8')
  try {
    const payload = encrypt(key, plaintext)
    return JSON.stringify({
      v: VAULT_FORMAT_VERSION,
      iv: payload.iv.toString('base64'),
      tag: payload.tag.toString('base64'),
      data: payload.data.toString('base64'),
    })
  } finally {
    plaintext.fill(0)
  }
}
