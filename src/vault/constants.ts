/**
 * Vault-scoped constants (ADR-0003). File names are relative to the journal
 * dir (`config.ts` `JOURNAL_DIR` by default); crypto parameters are fixed by
 * the AES-256-GCM choice and must not drift independently of `crypto.ts`.
 */

/** Master key file: base64 of `VAULT_KEY_LENGTH_BYTES` random bytes, mode 0600. */
export const VAULT_KEY_FILE_NAME = 'vault.key'

/** Encrypted store file: JSON envelope `{v, iv, tag, data}` (base64 fields), mode 0600. */
export const VAULT_ENC_FILE_NAME = 'vault.enc'

/**
 * Staging location for the NEW key during `vault rekey`. Its presence on disk
 * means a rekey was in flight; the read path uses it to recover from a crash
 * between the vault.enc commit and the key promotion (see `store.ts` rekey
 * ordering invariant).
 */
export const VAULT_STAGED_KEY_FILE_NAME = 'vault.key.new'

/** Envelope format version; bound into the ciphertext as AAD (ADR-0003 §4). */
export const VAULT_FORMAT_VERSION = 1

/** AES-256 key size. */
export const VAULT_KEY_LENGTH_BYTES = 32

/** GCM nonce size; fresh random per write — reuse with one key is catastrophic. */
export const VAULT_IV_LENGTH_BYTES = 12

/** GCM authentication tag size. */
export const VAULT_TAG_LENGTH_BYTES = 16

/**
 * AAD prefix; the envelope's `v` is appended so a ciphertext cannot be
 * re-wrapped under a different format version.
 */
export const VAULT_AAD_PREFIX = 'mcp-journal-vault:v'

/**
 * Secret names double as JSON keys and CLI arguments; the same shape as
 * registry server names (M3 plan): lowercase alphanumeric + dashes, max 64.
 */
export const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Prefix marking a registry env/header value as a vault reference. */
export const VAULT_REF_PREFIX = 'vault:'

/** A full, valid vault reference: `vault:<name>` with a valid secret name. */
export const VAULT_REF_PATTERN = /^vault:[a-z0-9][a-z0-9-]{0,63}$/
