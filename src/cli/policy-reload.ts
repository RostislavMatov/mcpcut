import type { LoadPolicyOptions } from '../policy/load.js'
import {
  createPolicyProvider,
  type PolicyProvider,
  type PolicyReloadEvent,
  type PolicyReloadFailure,
  type PolicyStat,
} from '../policy/reload.js'
import type { Policy } from '../policy/schema.js'

/**
 * The one place the three proxy entry points (`connect`, `wrap`, `serve`)
 * turn their one-time policy load into a hot-reloading provider, and the one
 * place the operator-facing wording of a reload lives (the rule itself is in
 * `policy/reload.ts`; this module owns the prose, as `connect-constants.ts`
 * owns the wording of the source notes — ADR-0005's split).
 *
 * Reloads are NOT journaled: the decision provenance already carries the
 * `policyHash` in force for every record, and the edit that caused the
 * reload is journaled by whoever made it (`kind: 'policy-edit'`). A reload
 * is not an act of a subject; only its FAILURE is worth a line, and that line
 * goes to stderr like every other proxy diagnostic.
 */

/** Hex characters of a policy hash shown in a diagnostic line. */
const POLICY_HASH_DISPLAY_CHARS = 8

/** Minimal writable shape shared by `process.stderr` and the CLI tests' capture objects. */
export interface PolicyReloadStderr {
  write(chunk: string): unknown
}

export interface ReloadingPolicyArgs {
  /** The policy the entry point loaded and validated at start-up. */
  readonly initial: Policy
  /** `PolicyLoadResult.sourcePath` of that load. */
  readonly sourcePath: string
  /** Exactly what `resolvePolicySource` returned for this entry point (ADR-0005). */
  readonly loadOptions: LoadPolicyOptions
  /** Where the two diagnostic lines go. Must already be guarded where stderr can break (`serve`). */
  readonly stderr: PolicyReloadStderr
  /** Test seam; see `CreatePolicyProviderArgs.stat`. */
  readonly stat?: PolicyStat
}

/** Builds the provider an entry point hands to its session, with stderr diagnostics attached. */
export function createReloadingPolicy(args: ReloadingPolicyArgs): PolicyProvider {
  return createPolicyProvider({
    initial: args.initial,
    sourcePath: args.sourcePath,
    loadOptions: args.loadOptions,
    ...(args.stat !== undefined ? { stat: args.stat } : {}),
    onReload: (event) => {
      args.stderr.write(formatPolicyReloaded(event))
    },
    onError: (failure) => {
      args.stderr.write(formatPolicyReloadFailure(failure))
    },
  })
}

/** `policy reloaded: <hash8> -> <hash8>` */
export function formatPolicyReloaded(event: PolicyReloadEvent): string {
  return `policy reloaded: ${shortHash(event.hashBefore)} -> ${shortHash(event.hashAfter)}\n`
}

/** `policy reload failed: <path>: <errors>; keeping policy <hash8>` */
export function formatPolicyReloadFailure(failure: PolicyReloadFailure): string {
  const errors = failure.errors.join('; ')
  return `policy reload failed: ${failure.sourcePath}: ${errors}; keeping policy ${shortHash(failure.keptHash)}\n`
}

function shortHash(hash: string): string {
  return hash.slice(0, POLICY_HASH_DISPLAY_CHARS)
}
