import { stat as fsStat } from 'node:fs/promises'
import { POLICY_RECHECK_MIN_MS } from './constants.js'
import { loadPolicy, type LoadPolicyOptions, type PolicyLoadResult } from './load.js'
import { policyHashOf } from './provenance.js'
import type { Policy } from './schema.js'

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
 * `journal.failClosed`, `quarantine.enabled` — those are read once when the
 * queue, waiter, sink and inventory are constructed and stay until restart.
 *
 * Two properties are load-bearing for the gate:
 *
 *  - **`current()` is synchronous.** The gate decides on a synchronous hot
 *    path and must never await the file system. A check is therefore
 *    *scheduled* by `maybeRefresh()` and the swap lands when the read
 *    completes; every decision made in between runs under the previous
 *    policy, and no decision ever sees a half-applied one (the swap is a
 *    single reference assignment of an already-parsed object).
 *  - **A failed reload keeps the last valid policy** (owner decision O3). A
 *    broken, unreadable or vanished file is reported through `onError` ONCE
 *    per file version — never once per call — and the policy in force does
 *    not move. Deleting the file on the fly is an error, not "enforcement
 *    off": silently dropping to journal-only is not a mode this supports.
 *
 * Re-reads go through `loadPolicy` with the SAME `loadOptions` the entry
 * point resolved through `resolvePolicySource`, so ADR-0005 keeps holding at
 * runtime: an agent-launched `connect` can never start reading a project or
 * `$MCP_JOURNAL_POLICY` file it was denied at start-up. A re-read that
 * resolves to a different file than the one this provider was bound to is
 * refused like any other failed reload.
 */

export interface PolicyProvider {
  /** The policy in force right now. Synchronous; never touches the file system. */
  current(): Policy
  /**
   * Schedules a version check, at most once per `POLICY_RECHECK_MIN_MS`.
   * Called by consumers right before a decision; returns immediately.
   */
  maybeRefresh(): void
  /** Runs one version check now (coalesced with an in-flight one). Never rejects. */
  refresh(): Promise<void>
  /** The file this provider is bound to, or `STATIC_POLICY_SOURCE`. */
  readonly sourcePath: string
}

/** `sourcePath` of a provider that wraps an in-memory value and never reloads. */
export const STATIC_POLICY_SOURCE = '<in-memory>'

/** What a version check compares: the two `stat` fields a hand edit always moves. */
export interface PolicyFileVersion {
  readonly mtimeMs: number
  readonly size: number
}

/** `stat` seam. The default reads `node:fs/promises`; rejects with `code: 'ENOENT'` for a missing file. */
export type PolicyStat = (path: string) => Promise<PolicyFileVersion>

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

export interface CreatePolicyProviderArgs {
  /** The policy the entry point already loaded and validated at start-up. */
  readonly initial: Policy
  /** The file `initial` was loaded from (`PolicyLoadResult.sourcePath`). */
  readonly sourcePath: string
  /** Exactly what the entry point resolved through `resolvePolicySource` (ADR-0005). */
  readonly loadOptions: LoadPolicyOptions
  readonly onReload?: (event: PolicyReloadEvent) => void
  readonly onError?: (failure: PolicyReloadFailure) => void
  /** Injectable clock (ms) for the recheck cooldown. Defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * Injectable `stat`. Defaults to the file system — unless `loadOptions`
   * injects a `readFile` and nothing injects a `stat`: then the version is
   * derived from that same reader, so a test that fakes the file's CONTENT
   * has faked its version too, and no real `stat` runs against a fake path.
   */
  readonly stat?: PolicyStat
}

/** Sentinel version keys for the two ways a check can fail before any read. */
const VERSION_ABSENT = 'absent'
const VERSION_STAT_ERROR_PREFIX = 'stat-error:'

type ObservedVersion =
  | { readonly key: string; readonly error?: undefined }
  | { readonly key: string; readonly error: string }

export function createPolicyProvider(args: CreatePolicyProviderArgs): PolicyProvider {
  const { sourcePath, loadOptions } = args
  const now = args.now ?? Date.now
  const stat = args.stat ?? defaultStatFor(loadOptions)
  const onReload = args.onReload ?? noop
  const onError = args.onError ?? noop

  let current: Policy = args.initial
  let lastCheckAt = Number.NEGATIVE_INFINITY
  /** `null` until the first check: the baseline is established by one read, never assumed. */
  let lastSeenVersion: string | null = null
  let inFlight: Promise<void> | null = null
  /** At most one follow-up check queued behind `inFlight` (see `refresh`). */
  let queued: Promise<void> | null = null

  function reportFailure(errors: readonly string[]): void {
    safely(() => onError({ sourcePath, errors, keptHash: policyHashOf(current) }))
  }

  /** Applies a successful load: swaps only when the EFFECTIVE policy changed. */
  function applyLoaded(result: Extract<PolicyLoadResult, { status: 'loaded' }>): void {
    if (result.sourcePath !== sourcePath) {
      reportFailure([
        `policy now resolves from a different file: ${result.sourcePath}; this process stays bound to ${sourcePath}`,
      ])
      return
    }
    const hashBefore = policyHashOf(current)
    const hashAfter = policyHashOf(result.policy)
    if (hashBefore === hashAfter) return
    current = result.policy
    safely(() => onReload({ sourcePath, hashBefore, hashAfter }))
  }

  async function checkOnce(): Promise<void> {
    const observed = await observeVersion(stat, sourcePath)
    if (observed.key === lastSeenVersion) return
    lastSeenVersion = observed.key
    if (observed.error !== undefined) {
      reportFailure([observed.error])
      return
    }

    const result = await loadPolicy(loadOptions)
    if (result.status === 'error') {
      reportFailure(result.errors)
      return
    }
    if (result.status === 'disabled') {
      reportFailure([`policy file not found: ${sourcePath}`])
      return
    }
    applyLoaded(result)
  }

  /**
   * A check that STARTS after this call, so an edit made before it is always
   * observed: joining a check already in flight would be joining one whose
   * `stat` may predate the edit. Concurrent callers share one follow-up —
   * it starts after the current check and sees every edit made before any
   * of them asked.
   */
  function refresh(): Promise<void> {
    if (inFlight === null) {
      inFlight = checkOnce()
        .catch((error: unknown) => {
          reportFailure([`policy reload failed unexpectedly: ${describeCause(error)}`])
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
    if (inFlight !== null || at - lastCheckAt < POLICY_RECHECK_MIN_MS) return
    lastCheckAt = at
    void refresh()
  }

  return Object.freeze({
    current: () => current,
    maybeRefresh,
    refresh,
    sourcePath,
  })
}

/** Wraps a policy that has no file behind it (tests; a value passed directly). */
export function staticPolicyProvider(policy: Policy): PolicyProvider {
  return Object.freeze({
    current: () => policy,
    maybeRefresh: noop,
    refresh: () => Promise.resolve(),
    sourcePath: STATIC_POLICY_SOURCE,
  })
}

export function isPolicyProvider(value: Policy | PolicyProvider): value is PolicyProvider {
  return typeof (value as Partial<PolicyProvider>).current === 'function'
}

/** Accepts either shape at a wiring seam; a plain value behaves exactly as before. */
export function toPolicyProvider(value: Policy | PolicyProvider): PolicyProvider {
  return isPolicyProvider(value) ? value : staticPolicyProvider(value)
}

/**
 * A provider whose `current()` is `transform(source.current())`, derived once
 * per distinct source object: consumers that cache on identity (the
 * provenance hash) keep their cache until the source actually swaps, and a
 * transform that returns its input unchanged costs nothing. Used for the
 * `--fail-closed` override, which used to be applied to the loaded VALUE.
 */
export function mapPolicyProvider(
  source: PolicyProvider,
  transform: (policy: Policy) => Policy,
): PolicyProvider {
  let lastSource: Policy | null = null
  let lastMapped: Policy | null = null
  return Object.freeze({
    current: () => {
      const policy = source.current()
      if (policy !== lastSource || lastMapped === null) {
        lastSource = policy
        lastMapped = transform(policy)
      }
      return lastMapped
    },
    maybeRefresh: () => source.maybeRefresh(),
    refresh: () => source.refresh(),
    sourcePath: source.sourcePath,
  })
}

/**
 * The version key for one check. A missing file and a failing `stat` are
 * versions in their own right, so each is reported once and a later
 * reappearance (or a different failure) is seen as a change.
 */
async function observeVersion(stat: PolicyStat, sourcePath: string): Promise<ObservedVersion> {
  try {
    const version = await stat(sourcePath)
    return { key: `${version.mtimeMs}:${version.size}` }
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return { key: VERSION_ABSENT, error: `policy file not found: ${sourcePath}` }
    }
    const cause = describeCause(error)
    return {
      key: `${VERSION_STAT_ERROR_PREFIX}${cause}`,
      error: `cannot stat policy file "${sourcePath}": ${cause}`,
    }
  }
}

function defaultStatFor(loadOptions: LoadPolicyOptions): PolicyStat {
  const readFile = loadOptions.readFile
  return readFile !== undefined ? statViaReadFile(readFile) : fileSystemStat
}

async function fileSystemStat(path: string): Promise<PolicyFileVersion> {
  const stats = await fsStat(path)
  return { mtimeMs: stats.mtimeMs, size: stats.size }
}

/**
 * Versioning through an injected reader: the content IS the version. `size`
 * carries the text length and `mtimeMs` a cheap content fingerprint, so an
 * edit that keeps the length (`allow` -> `deny!`) still moves the key.
 */
function statViaReadFile(readFile: NonNullable<LoadPolicyOptions['readFile']>): PolicyStat {
  return async (path) => {
    const text = await readFile(path)
    return { mtimeMs: contentFingerprint(text), size: text.length }
  }
}

/** FNV-1a over UTF-16 code units: not a security primitive, only a change detector for a test seam. */
function contentFingerprint(text: string): number {
  const FNV_OFFSET = 0x811c9dc5
  const FNV_PRIME = 0x01000193
  let hash = FNV_OFFSET
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), FNV_PRIME) >>> 0
  }
  return hash
}

/** A diagnostics callback that throws must not take the provider down with it. */
function safely(callback: () => void): void {
  try {
    callback()
  } catch {
    // Deliberately dropped: the only place left to report to is the callback that just failed.
  }
}

function noop(): void {
  // Intentionally empty.
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
