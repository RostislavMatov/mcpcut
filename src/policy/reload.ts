import { POLICY_RECHECK_MIN_MS } from './constants.js'
import { loadPolicy, parsePolicyText, type LoadPolicyOptions, type PolicyLoadResult } from './load.js'
import { policyHashOf } from './provenance.js'
import type { PolicyProvider } from './provider.js'
import {
  VERSION_STAT_ERROR_PREFIX,
  defaultStatFor,
  describeCause,
  firstExisting,
  firstExistingSync,
  observeVersion,
  observeVersionSync,
  safely,
  syncFsOf,
  type PolicyReadFileSync,
  type PolicyStat,
  type PolicyStatSync,
  type PolicySyncFs,
} from './reload-fs.js'
import type { Policy } from './schema.js'

export {
  STATIC_POLICY_SOURCE,
  isPolicyProvider,
  mapPolicyProvider,
  staticPolicyProvider,
  toPolicyProvider,
  type PolicyProvider,
} from './provider.js'
export type { PolicyFileVersion, PolicyReadFileSync, PolicyStat, PolicyStatSync } from './reload-fs.js'

/**
 * Hot reload of `policy.json` for a running proxy (policy-tool-rules-ui plan,
 * wave 2; ADR-0009). A `PolicyProvider` replaces the `Policy` VALUE that used
 * to be handed to the gate at wiring time: the three per-call consumers —
 * `decide()` in the gate, the `tools/list` visibility filter and the decision
 * provenance writer — read `current()` instead of a captured object, so an
 * edit made from the UI, the CLI or by hand reaches them without a restart.
 *
 * What reloads is what those consumers read: the RULES (`servers.*`,
 * `classDefaults`, `defaultDecision`, `toolsList.filter`,
 * `quarantine.onQuarantined`). What does NOT reload is the configuration the
 * session was wired with — `approval.timeoutMs`, `approval.grantTtlMs`,
 * `journal.failClosed`, `quarantine.enabled` — read once at construction.
 *
 * Three properties are load-bearing for the gate:
 *
 *  - **The NEXT decision after an edit sees it.** `maybeRefresh()` runs on the
 *    gate's synchronous hot path, at most once per `POLICY_RECHECK_MIN_MS`:
 *    one sync `stat` of the bound file (cheap), and only when `mtime`/`size`
 *    moved a sync read + parse + swap, all before it returns. The sync read on
 *    the hot path is deliberate — the file is small and it costs one read per
 *    ACTUAL change; an asynchronous swap would land one call late, which the
 *    wave gate forbids. The async `refresh()` remains for explicit callers; a
 *    result of its is discarded when a later check observed the file after
 *    it, so a stale async read can never swap back over a newer sync swap.
 *  - **A failed reload keeps the last valid policy** (owner decision O3). A
 *    broken, unreadable or vanished file is reported through `onError` ONCE
 *    per distinct failure, and the policy in force does not move. While the
 *    file is broken every check re-reads it rather than trusting the version
 *    key, so a same-size fix inside one mtime tick is not masked.
 *  - **The source is pinned for the life of the process** (ADR-0005). The
 *    async path re-reads through the SAME `loadOptions` the entry point
 *    resolved, the sync path reads the bound file only; a read that resolves
 *    to a different file is refused, and a higher-priority candidate that
 *    APPEARS after binding is reported through `onShadowed` (once, until it
 *    disappears) but never switched to — a fresh start would read it, this
 *    process keeps enforcing what it was bound to.
 */

export interface PolicyReloadEvent {
  readonly sourcePath: string
  readonly hashBefore: string
  readonly hashAfter: string
}

export interface PolicyReloadFailure {
  readonly sourcePath: string
  /** Human-readable lines: the loader's own, or one line describing the stat/vanish failure. */
  readonly errors: readonly string[]
  /** Hash of the policy still in force, so the diagnostic can name it. */
  readonly keptHash: string
}

/** A higher-priority candidate exists now; a fresh start would read it, this process does not. */
export interface PolicyShadowedEvent {
  readonly shadowingPath: string
  readonly sourcePath: string
  readonly keptHash: string
}

export interface CreatePolicyProviderArgs {
  /** The policy the entry point already loaded and validated at start-up. */
  readonly initial: Policy
  /** The file `initial` was loaded from (`PolicyLoadResult.sourcePath`). */
  readonly sourcePath: string
  /** Exactly what the entry point resolved through `resolvePolicySource` (ADR-0005). */
  readonly loadOptions: LoadPolicyOptions
  /**
   * Candidate paths that resolve BEFORE `sourcePath` in the entry point's
   * order and did not exist at start-up. Each check stats them; one that
   * appears is reported via `onShadowed`. Omitted = no shadow check.
   */
  readonly precedingCandidates?: readonly string[]
  readonly onReload?: (event: PolicyReloadEvent) => void
  readonly onError?: (failure: PolicyReloadFailure) => void
  readonly onShadowed?: (event: PolicyShadowedEvent) => void
  /** Injectable clock (ms) for the recheck cooldown. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Async `stat` seam for `refresh()`; see `defaultStatFor`. */
  readonly stat?: PolicyStat
  /** Sync seams for the hot path; see `syncFsOf` for how they default. */
  readonly statSync?: PolicyStatSync
  readonly readFileSync?: PolicyReadFileSync
}

export function createPolicyProvider(args: CreatePolicyProviderArgs): PolicyProvider {
  const { sourcePath, loadOptions } = args
  const precedingCandidates = args.precedingCandidates ?? []
  const now = args.now ?? Date.now
  const stat = args.stat ?? defaultStatFor(loadOptions)
  const syncFs = syncFsOf(loadOptions, args.statSync, args.readFileSync)
  const onReload = args.onReload ?? noop
  const onError = args.onError ?? noop
  const onShadowed = args.onShadowed ?? noop

  let current: Policy = args.initial
  let lastCheckAt = Number.NEGATIVE_INFINITY
  /** `null` until the first check: the baseline is established by one read, never assumed. */
  let lastSeenVersion: string | null = null
  /**
   * Non-null while the last observed version FAILED to load: the version key
   * plus the errors it produced. Disables the equal-key short-circuit (the
   * file is re-read on every check) and dedupes the diagnostic — a still
   * broken file is not re-reported, a differently broken one is.
   */
  let lastFailureSignature: string | null = null
  /** The preceding candidate currently reported as shadowing, or `null`. */
  let shadowingPath: string | null = null
  /** Counts observations of the bound file; an async check whose serial is stale discards its result. */
  let observeSerial = 0
  let inFlight: Promise<void> | null = null
  /** At most one follow-up check queued behind `inFlight` (see `refresh`). */
  let queued: Promise<void> | null = null

  function failWith(versionKey: string, errors: readonly string[]): void {
    const signature = `${versionKey}\n${errors.join('\n')}`
    if (signature === lastFailureSignature) return
    lastFailureSignature = signature
    safely(() => onError({ sourcePath, errors, keptHash: policyHashOf(current) }))
  }

  /** A version worth reading: new, or the same one while it is known to be broken. */
  function shouldRead(versionKey: string): boolean {
    return versionKey !== lastSeenVersion || lastFailureSignature !== null
  }

  /** Applies one read of the bound file: swaps only when the EFFECTIVE policy changed. */
  function applyResult(versionKey: string, result: PolicyLoadResult): void {
    if (result.status === 'error') {
      failWith(versionKey, result.errors)
      return
    }
    if (result.status === 'disabled') {
      failWith(versionKey, [`policy file not found: ${sourcePath}`])
      return
    }
    if (result.sourcePath !== sourcePath) {
      failWith(versionKey, [
        `policy now resolves from a different file: ${result.sourcePath}; this process stays bound to ${sourcePath}`,
      ])
      return
    }
    lastFailureSignature = null
    const hashBefore = policyHashOf(current)
    const hashAfter = policyHashOf(result.policy)
    if (hashBefore === hashAfter) return
    current = result.policy
    safely(() => onReload({ sourcePath, hashBefore, hashAfter }))
  }

  function applyShadowing(found: string | null): void {
    if (found === shadowingPath) return
    shadowingPath = found
    if (found === null) return
    safely(() => onShadowed({ shadowingPath: found, sourcePath, keptHash: policyHashOf(current) }))
  }

  /** The hot path: stat, and on a change read + parse + swap, all before returning. */
  function checkBoundFileSync(fs: PolicySyncFs): void {
    observeSerial += 1
    const observed = observeVersionSync(fs.statSync, sourcePath)
    if (!shouldRead(observed.key)) return
    lastSeenVersion = observed.key
    if (observed.error !== undefined) {
      failWith(observed.key, [observed.error])
      return
    }
    let text: string
    try {
      text = fs.readFileSync(sourcePath)
    } catch (error: unknown) {
      failWith(observed.key, [`cannot read policy file "${sourcePath}": ${describeCause(error)}`])
      return
    }
    applyResult(observed.key, parsePolicyText(sourcePath, text))
  }

  async function checkBoundFile(): Promise<void> {
    observeSerial += 1
    const serial = observeSerial
    const observed = await observeVersion(stat, sourcePath)
    if (!shouldRead(observed.key)) return
    if (observed.error !== undefined) {
      lastSeenVersion = observed.key
      failWith(observed.key, [observed.error])
      return
    }
    const result = await loadPolicy(loadOptions)
    // A later check (the sync hot path, typically) observed the file after
    // this one did: its verdict is fresher, and this read must not win.
    if (observeSerial !== serial) return
    lastSeenVersion = observed.key
    applyResult(observed.key, result)
  }

  async function checkOnce(): Promise<void> {
    await checkBoundFile()
    applyShadowing(await firstExisting(stat, precedingCandidates))
  }

  function checkOnceSync(fs: PolicySyncFs): void {
    try {
      checkBoundFileSync(fs)
      applyShadowing(firstExistingSync(fs.statSync, precedingCandidates))
    } catch (error: unknown) {
      failWith(VERSION_STAT_ERROR_PREFIX, [`policy reload failed unexpectedly: ${describeCause(error)}`])
    }
  }

  /**
   * A check that STARTS after this call, so an edit made before it is always
   * observed: joining a check already in flight would be joining one whose
   * `stat` may predate the edit. Concurrent callers share one follow-up.
   */
  function refresh(): Promise<void> {
    if (inFlight === null) {
      inFlight = checkOnce()
        .catch((error: unknown) => {
          failWith(VERSION_STAT_ERROR_PREFIX, [`policy reload failed unexpectedly: ${describeCause(error)}`])
        })
        .finally(() => {
          inFlight = null
        })
      return inFlight
    }
    if (queued === null) {
      queued = inFlight.then(() => {
        queued = null
        return refresh()
      })
    }
    return queued
  }

  function maybeRefresh(): void {
    const at = now()
    if (at - lastCheckAt < POLICY_RECHECK_MIN_MS) return
    lastCheckAt = at
    if (syncFs === null) {
      void refresh()
      return
    }
    checkOnceSync(syncFs)
  }

  return Object.freeze({
    current: () => current,
    maybeRefresh,
    refresh,
    sourcePath,
  })
}


function noop(): void {
  // Intentionally empty.
}
