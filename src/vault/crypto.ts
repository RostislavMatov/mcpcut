import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  VAULT_AAD_PREFIX,
  VAULT_FORMAT_VERSION,
  VAULT_IV_LENGTH_BYTES,
  VAULT_KEY_LENGTH_BYTES,
  VAULT_TAG_LENGTH_BYTES,
} from './constants.js'

/**
 * AES-256-GCM primitives for the vault (ADR-0003). `node:crypto` only.
 * Deliberately payload-shaped, not file-shaped: base64/JSON envelope handling
 * lives in `store.ts`, so this module can be reviewed as ~pure crypto.
 *
 * Decryption NEVER returns garbage: any authentication failure (flipped tag,
 * tampered ciphertext, wrong key, wrong AAD/version) throws
 * `VaultIntegrityError` — GCM's tag check in `final()` guarantees it.
 */

const CIPHER_ALGORITHM = 'aes-256-gcm'

/** One encrypted payload: the three envelope fields, as raw bytes. */
export interface EncryptedPayload {
  readonly iv: Buffer
  readonly tag: Buffer
  readonly data: Buffer
}

/** Authentication/integrity failure: tampered or truncated payload, wrong key, wrong version. */
export class VaultIntegrityError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'VaultIntegrityError'
  }
}

/** A key of the wrong size — a caller bug or a corrupt key file, never recoverable here. */
export class VaultKeyError extends Error {
  constructor(actualLength: number) {
    super(`vault key must be ${VAULT_KEY_LENGTH_BYTES} bytes, got ${actualLength}`)
    this.name = 'VaultKeyError'
  }
}

/** Fresh 256-bit master key. */
export function generateKey(): Buffer {
  return randomBytes(VAULT_KEY_LENGTH_BYTES)
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== VAULT_KEY_LENGTH_BYTES) {
    throw new VaultKeyError(key.length)
  }
}

/** The format version is bound in as AAD so an envelope cannot be re-labeled with another `v`. */
function aadFor(version: number): Buffer {
  return Buffer.from(`${VAULT_AAD_PREFIX}${version}`, 'utf8')
}

/** Encrypts `plaintext` with a fresh random IV (never reused across writes). */
export function encrypt(
  key: Buffer,
  plaintext: Buffer,
  version: number = VAULT_FORMAT_VERSION,
): EncryptedPayload {
  assertKeyLength(key)
  const iv = randomBytes(VAULT_IV_LENGTH_BYTES)
  const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv)
  cipher.setAAD(aadFor(version))
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return { iv, tag, data }
}

/**
 * Decrypts and authenticates. Malformed field lengths are rejected up front
 * with the same `VaultIntegrityError` as a failed tag check, so callers have
 * exactly one integrity failure mode to handle.
 */
export function decrypt(
  key: Buffer,
  payload: EncryptedPayload,
  version: number = VAULT_FORMAT_VERSION,
): Buffer {
  assertKeyLength(key)
  if (payload.iv.length !== VAULT_IV_LENGTH_BYTES || payload.tag.length !== VAULT_TAG_LENGTH_BYTES) {
    throw new VaultIntegrityError(
      `vault payload is malformed (iv ${payload.iv.length} bytes, tag ${payload.tag.length} bytes)`,
    )
  }
  try {
    const decipher = createDecipheriv(CIPHER_ALGORITHM, key, payload.iv)
    decipher.setAAD(aadFor(version))
    decipher.setAuthTag(payload.tag)
    return Buffer.concat([decipher.update(payload.data), decipher.final()])
  } catch (error: unknown) {
    throw new VaultIntegrityError(
      'vault payload failed authentication (corrupted, tampered with, or encrypted under a different key)',
      error,
    )
  }
}
