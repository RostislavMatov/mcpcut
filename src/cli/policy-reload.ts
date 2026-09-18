import type { LoadPolicyOptions } from '../policy/load.js'
import {
  createPolicyProvider,
  type PolicyProvider,
  type PolicyReloadEvent,
  type PolicyReloadFailure,
  type PolicyShadowedEvent,
  type PolicyStat,
} from '../policy/reload.js'
import { createAwaitingPolicyProvider, type PolicyAdoptedEvent } from '../policy/reload-await.js'
import type { Policy } from '../policy/schema.js'
import type { PolicySourceCandidate } from '../policy/source.js'

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
  /**
   * `resolvePolicySource().candidates`, in resolution order. The ones before
   * `sourcePath` did not exist at start-up; one appearing later is reported
   * as shadowing (never switched to). Omitted = no shadow check.
   */
  readonly candidates?: readonly PolicySourceCandidate[]
  /** Where the diagnostic lines go. Must already be guarded where stderr can break (`serve`). */
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
    precedingCandidates: precedingCandidatesOf(args.candidates ?? [], args.sourcePath),
    ...(args.stat !== undefined ? { stat: args.stat } : {}),
    onReload: (event) => {
      args.stderr.write(formatPolicyReloaded(event))
    },
    onError: (failure) => {
      args.stderr.write(formatPolicyReloadFailure(failure))
    },
    onShadowed: (event) => {
      args.stderr.write(formatPolicyShadowed(event))
    },
  })
}

export interface AwaitingPolicyArgs {
  /** The policy in force while no file exists (`journalingOnlyPolicy()`). */
  readonly fallback: Policy
  /** Exactly what `resolvePolicySource` returned for this entry point (ADR-0005). */
  readonly loadOptions: LoadPolicyOptions
  /** `resolvePolicySource().candidates`: where this entry point looks, in order. None existed at start-up. */
  readonly candidates: readonly PolicySourceCandidate[]
  readonly stderr: PolicyReloadStderr
}

/**
 * The provider for a start-up that found NO policy file: journaling only for
 * now, and the first valid file to appear where this entry point looks is
 * adopted without a restart (owner decision 2026-09-18; the rule is in
 * `policy/reload-await.ts`, the wording below).
 */
export function createAwaitingPolicy(args: AwaitingPolicyArgs): PolicyProvider {
  return createAwaitingPolicyProvider({
    fallback: args.fallback,
    loadOptions: args.loadOptions,
    candidates: args.candidates.map((candidate) => candidate.path),
    onAdopted: (event) => {
      args.stderr.write(formatPolicyAdopted(event))
    },
    onRejected: (failure) => {
      args.stderr.write(formatPolicyNotAdopted(failure))
    },
    onReload: (event) => {
      args.stderr.write(formatPolicyReloaded(event))
    },
    onError: (failure) => {
      args.stderr.write(formatPolicyReloadFailure(failure))
    },
    onShadowed: (event) => {
      args.stderr.write(formatPolicyShadowed(event))
    },
  })
}

/** The candidate paths tried before the one that was actually loaded. */
function precedingCandidatesOf(
  candidates: readonly PolicySourceCandidate[],
  sourcePath: string,
): readonly string[] {
  const boundIndex = candidates.findIndex((candidate) => candidate.path === sourcePath)
  const preceding = boundIndex === -1 ? [] : candidates.slice(0, boundIndex)
  return preceding.map((candidate) => candidate.path)
}

/** `policy reloaded: <hash8> -> <hash8>` */
export function formatPolicyReloaded(event: PolicyReloadEvent): string {
  return `policy reloaded: ${shortHash(event.hashBefore)} -> ${shortHash(event.hashAfter)}\n`
}

/** `policy adopted: <path> (<hash8>); enforcing it from now on — …` */
export function formatPolicyAdopted(event: PolicyAdoptedEvent): string {
  return (
    `policy adopted: ${event.sourcePath} (${shortHash(event.hashAfter)}); enforcing it from now on — ` +
    'sessions already open keep their approval timeouts and fail-closed setting until reopened\n'
  )
}

/** `policy file not adopted: <path>: <errors>; still journaling only` */
export function formatPolicyNotAdopted(failure: PolicyReloadFailure): string {
  return `policy file not adopted: ${failure.sourcePath}: ${failure.errors.join('; ')}; still journaling only\n`
}

/** `policy reload failed: <path>: <errors>; keeping policy <hash8>` */
export function formatPolicyReloadFailure(failure: PolicyReloadFailure): string {
  const errors = failure.errors.join('; ')
  return `policy reload failed: ${failure.sourcePath}: ${errors}; keeping policy ${shortHash(failure.keptHash)}\n`
}

/** `policy shadowed: <path> now resolves first; still enforcing <bound> (<hash8>) — restart to switch` */
export function formatPolicyShadowed(event: PolicyShadowedEvent): string {
  return (
    `policy shadowed: ${event.shadowingPath} now resolves first; ` +
    `still enforcing ${event.sourcePath} (${shortHash(event.keptHash)}) — restart to switch\n`
  )
}

function shortHash(hash: string): string {
  return hash.slice(0, POLICY_HASH_DISPLAY_CHARS)
}
