import { POLICY_RECHECK_MIN_MS } from './constants.js'
import { loadPolicy, parsePolicyText, type LoadPolicyOptions, type PolicyLoadResult } from './load.js'
import { policyHashOf } from './provenance.js'
import type { PolicyProvider } from './provider.js'
import {
  createPolicyProvider,
  type PolicyReadFileSync,
  type PolicyReloadEvent,
  type PolicyReloadFailure,
  type PolicyShadowedEvent,
  type PolicyStat,
  type PolicyStatSync,
} from './reload.js'
import {
  defaultStatFor,
  describeCause,
  firstExisting,
  firstExistingSync,
  safely,
  syncFsOf,
  type PolicySyncFs,
} from './reload-fs.js'
import type { Policy } from './schema.js'

/**
 * A provider for a process that started with NO policy file (`connect` and
 * `serve` then run the journaling-only policy). Until the 2026-09-18
 * user-journey smoke that fallback was a static value: `setup` starts `serve`
 * before any `policy.json` exists, the operator writes one afterwards, the
 * admin UI shows its hash -- and the front kept allowing everything until a
 * restart nobody knew was needed (M1; owner decision of the same day: adopt).
 *
 * So the fallback now WAITS. On the same hot-path cadence as a reload
 * (`POLICY_RECHECK_MIN_MS`) it stats the entry point's own candidates, in the
 * entry point's own resolution order, and the first one that holds a VALID
 * policy is bound -- before `maybeRefresh()` returns, so the decision that
 * noticed the file is already made under it.
 *
 *  - **Adoption only ever tightens.** The fallback is the most permissive
 *    policy there is (grants aside), so no file can widen what it allowed.
 *  - **A broken file is never adopted** (O3's rule, mirrored): the fallback
 *    stays in force, the failure is reported once per distinct failure, and
 *    the file is re-read on every check so a fix lands on the next decision.
 *  - **Binding happens once.** From then on this IS a `createPolicyProvider`
 *    over that file: pinned source, shadow reports, keep-last-valid on a
 *    vanish (ADR-0005, ADR-0009). It never falls back to journaling-only.
 *
 * What adoption cannot change is what a session was WIRED with
 * (`approval.timeoutMs`, `approval.grantTtlMs`, `journal.failClosed`): a
 * session opened under the fallback keeps the fallback's wiring until it is
 * reopened, exactly as a reload never rewires one.
 */

/** `sourcePath` while no file has been adopted yet. */
export const NO_POLICY_SOURCE = '<no policy file>'

/** Same shape as a reload: the fallback's hash, then the adopted file's. */
export type PolicyAdoptedEvent = PolicyReloadEvent

export interface CreateAwaitingPolicyProviderArgs {
  /** In force until a file is adopted. */
  readonly fallback: Policy
  /** Exactly what the entry point resolved through `resolvePolicySource` (ADR-0005). */
  readonly loadOptions: LoadPolicyOptions
  /** Every path the entry point would have read, in resolution order; none existed at start-up. */
  readonly candidates: readonly string[]
  readonly onAdopted?: (event: PolicyAdoptedEvent) => void
  /** Before adoption: a candidate exists but does not load. `keptHash` is the fallback's. */
  readonly onRejected?: (failure: PolicyReloadFailure) => void
  /** After adoption: the bound provider's reload failures, unchanged. */
  readonly onError?: (failure: PolicyReloadFailure) => void
  readonly onReload?: (event: PolicyReloadEvent) => void
  readonly onShadowed?: (event: PolicyShadowedEvent) => void
  readonly now?: () => number
  readonly stat?: PolicyStat
  readonly statSync?: PolicyStatSync
  readonly readFileSync?: PolicyReadFileSync
}

export function createAwaitingPolicyProvider(args: CreateAwaitingPolicyProviderArgs): PolicyProvider {
  const { fallback, loadOptions, candidates } = args
  const now = args.now ?? Date.now
  const stat = args.stat ?? defaultStatFor(loadOptions)
  const syncFs = syncFsOf(loadOptions, args.statSync, args.readFileSync)

  let bound: PolicyProvider | null = null
  let lastCheckAt = Number.NEGATIVE_INFINITY
  let lastFailureSignature: string | null = null

  function failWith(sourcePath: string, errors: readonly string[]): void {
    const signature = `${sourcePath}\n${errors.join('\n')}`
    if (signature === lastFailureSignature) return
    lastFailureSignature = signature
    safely(() => args.onRejected?.({ sourcePath, errors, keptHash: policyHashOf(fallback) }))
  }

  function bind(sourcePath: string, policy: Policy): void {
    bound = createPolicyProvider({
      initial: policy,
      sourcePath,
      loadOptions,
      precedingCandidates: candidates.slice(0, Math.max(0, candidates.indexOf(sourcePath))),
      now,
      ...(args.stat !== undefined ? { stat: args.stat } : {}),
      ...(args.statSync !== undefined ? { statSync: args.statSync } : {}),
      ...(args.readFileSync !== undefined ? { readFileSync: args.readFileSync } : {}),
      ...(args.onReload !== undefined ? { onReload: args.onReload } : {}),
      ...(args.onError !== undefined ? { onError: args.onError } : {}),
      ...(args.onShadowed !== undefined ? { onShadowed: args.onShadowed } : {}),
    })
    safely(() =>
      args.onAdopted?.({ sourcePath, hashBefore: policyHashOf(fallback), hashAfter: policyHashOf(policy) }),
    )
  }

  /** `found` is where a file was seen; a result naming another file means the candidates moved under the read. */
  function adopt(found: string, result: PolicyLoadResult): void {
    if (bound !== null || result.status === 'disabled') return
    if (result.status === 'error') {
      failWith(result.sourcePath, result.errors)
      return
    }
    if (!candidates.includes(result.sourcePath)) {
      failWith(found, [`policy resolved from an unexpected file: ${result.sourcePath}`])
      return
    }
    bind(result.sourcePath, result.policy)
  }

  function checkSync(fs: PolicySyncFs): void {
    try {
      const found = firstExistingSync(fs.statSync, candidates)
      if (found === null) return
      adopt(found, parsePolicyText(found, fs.readFileSync(found)))
    } catch (error: unknown) {
      failWith(NO_POLICY_SOURCE, [`looking for a policy file failed: ${describeCause(error)}`])
    }
  }

  /** Test-seam configuration only (an injected async reader has no sync twin); see `syncFsOf`. */
  async function checkAsync(): Promise<void> {
    try {
      const found = await firstExisting(stat, candidates)
      if (found === null) return
      adopt(found, await loadPolicy(loadOptions))
    } catch (error: unknown) {
      failWith(NO_POLICY_SOURCE, [`looking for a policy file failed: ${describeCause(error)}`])
    }
  }

  async function refresh(): Promise<void> {
    // Starts after this call, like `createPolicyProvider`'s: never a stale look.
    await Promise.resolve()
    if (bound !== null) return bound.refresh()
    if (syncFs !== null) checkSync(syncFs)
    else await checkAsync()
  }

  function maybeRefresh(): void {
    if (bound !== null) {
      bound.maybeRefresh()
      return
    }
    const at = now()
    if (at - lastCheckAt < POLICY_RECHECK_MIN_MS) return
    lastCheckAt = at
    if (syncFs !== null) checkSync(syncFs)
    else void checkAsync()
  }

  return Object.freeze({
    current: () => (bound !== null ? bound.current() : fallback),
    maybeRefresh,
    refresh,
    get sourcePath(): string {
      return bound !== null ? bound.sourcePath : NO_POLICY_SOURCE
    },
  })
}
