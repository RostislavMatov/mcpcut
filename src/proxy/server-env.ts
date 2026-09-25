import type { ResolveVaultRefsResult } from '../vault/resolve.js'

/**
 * Pure assembly of a registry server's child environment (M3 Task 8).
 *
 * Layering, bottom to top:
 * 1. `processEnv ∩ allowlist` — the minimal system slice a child needs to
 *    function (see SYSTEM_ENV_ALLOWLIST in config.ts);
 * 2. the server record's declared env — literals as-is, `vault:<name>`
 *    references dereferenced through the injected resolver. A declared
 *    variable always overrides an inherited one.
 *
 * This module knows nothing about files, crypto, or spawning — the vault
 * resolver is injected (signature matches `resolveVaultRefs` partially
 * applied with a store), and the result is handed to spawnServer by the
 * calling side (connect/serve, Wave 4).
 */

/**
 * Dereferences `vault:` values in an env record. Shape-compatible with
 * `(record) => resolveVaultRefs(record, store.readSecretValues)`.
 */
export type ResolveEnvRefsFn = (record: Record<string, string>) => Promise<ResolveVaultRefsResult>

export interface BuildServerEnvOptions {
  /** The control plane's own environment (never mutated). */
  readonly processEnv: NodeJS.ProcessEnv
  /** Variable names the child may inherit from processEnv. */
  readonly allowlist: readonly string[]
  /** The registry record's env: literals and `vault:` references. */
  readonly declaredEnv: Readonly<Record<string, string>>
  readonly resolveRefs: ResolveEnvRefsFn
}

export type BuildServerEnvResult =
  | { readonly status: 'built'; readonly env: Readonly<Record<string, string>> }
  /** Any resolver failure (invalid-refs / missing-secrets / vault-error) passes through unchanged. */
  | Exclude<ResolveVaultRefsResult, { readonly status: 'resolved' }>

/** Builds the exact environment a registry server's child process receives. */
export async function buildServerEnv(opts: BuildServerEnvOptions): Promise<BuildServerEnvResult> {
  const inherited = pickAllowlisted(opts.processEnv, opts.allowlist)

  const resolved = await opts.resolveRefs({ ...opts.declaredEnv })
  if (resolved.status !== 'resolved') {
    // Missing secrets arrive as the full list of absent names; invalid refs
    // must never fall through to the child as literal `vault:...` strings.
    return resolved
  }

  return { status: 'built', env: Object.freeze({ ...inherited, ...resolved.values }) }
}

/** New record with only the allowlisted names that exist in processEnv (undefined values dropped). */
function pickAllowlisted(
  processEnv: NodeJS.ProcessEnv,
  allowlist: readonly string[],
): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const name of allowlist) {
    const value = processEnv[name]
    if (typeof value === 'string') {
      picked[name] = value
    }
  }
  return picked
}

/**
 * Variables an ad-hoc `wrap` child must NOT inherit. `npx -p <pkg> mcpcut
 * wrap -- npx -y <server>` leaves `npm_config_package` set, and a nested
 * `npx` then runs the server's name as a command. Only that one: the rest of
 * `npm_config_*` (a private registry, a proxy) is the operator's own setting.
 */
const WRAP_ENV_DENYLIST: ReadonlySet<string> = new Set(['npm_config_package'])

/**
 * The ad-hoc `wrap` child's environment: the operator's shell as-is (the
 * server was going to run there anyway), minus `WRAP_ENV_DENYLIST`.
 */
export function buildWrapServerEnv(processEnv: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const kept = Object.entries(processEnv).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !WRAP_ENV_DENYLIST.has(entry[0]),
  )
  return Object.freeze(Object.fromEntries(kept))
}
