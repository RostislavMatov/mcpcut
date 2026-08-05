import { VAULT_REF_PATTERN, VAULT_REF_PREFIX } from './constants.js'
import type { ReadSecretValuesResult, VaultFailure } from './store.js'

/**
 * Dereferences `vault:<name>` values in env/header records from the registry
 * (M3 plan Task 3/8). Literals pass through untouched. Decrypted values live
 * ONLY in the returned in-memory record on their way into an upstream
 * process's env/headers — nothing here logs, prints, or persists them.
 */

/** True for a complete, valid `vault:<name>` reference. */
export function isVaultRef(value: string): boolean {
  return VAULT_REF_PATTERN.test(value)
}

/**
 * Reads decrypted values for `names`; absent names are omitted from
 * `values`. Matches `VaultStore.readSecretValues`.
 */
export type ReadSecretValuesFn = (names: readonly string[]) => Promise<ReadSecretValuesResult>

export type ResolveVaultRefsResult =
  | { readonly status: 'resolved'; readonly values: Record<string, string> }
  /** Values that start with `vault:` but are not valid refs — fail fast, NEVER passed through as literals. */
  | { readonly status: 'invalid-refs'; readonly refs: readonly string[] }
  /** Every referenced-but-absent secret name, reported all at once. */
  | { readonly status: 'missing-secrets'; readonly missing: readonly string[] }
  | { readonly status: 'vault-error'; readonly failure: VaultFailure }

/** Replaces every `vault:<name>` value in `record` with its decrypted secret. */
export async function resolveVaultRefs(
  record: Record<string, string>,
  readValues: ReadSecretValuesFn,
): Promise<ResolveVaultRefsResult> {
  const invalidRefs = Object.values(record).filter(
    (value) => value.startsWith(VAULT_REF_PREFIX) && !isVaultRef(value),
  )
  if (invalidRefs.length > 0) return { status: 'invalid-refs', refs: invalidRefs }

  const names = [
    ...new Set(
      Object.values(record)
        .filter(isVaultRef)
        .map((value) => value.slice(VAULT_REF_PREFIX.length)),
    ),
  ]
  if (names.length === 0) return { status: 'resolved', values: { ...record } }

  const read = await readValues(names)
  if (read.status !== 'read') return { status: 'vault-error', failure: read }

  const missing = names.filter((name) => read.values[name] === undefined)
  if (missing.length > 0) return { status: 'missing-secrets', missing }

  return { status: 'resolved', values: substituteRefs(record, read.values) }
}

function substituteRefs(
  record: Record<string, string>,
  secrets: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!isVaultRef(value)) {
      resolved[key] = value
      continue
    }
    const secret = secrets[value.slice(VAULT_REF_PREFIX.length)]
    if (secret === undefined) {
      // Unreachable: the missing-secrets check above already covered it; kept
      // as a hard failure so a future refactor cannot silently leak the raw ref.
      throw new Error(`vault ref "${value}" vanished between the missing check and substitution`)
    }
    resolved[key] = secret
  }
  return resolved
}
