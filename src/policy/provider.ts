import type { Policy } from './schema.js'

/**
 * The shape the gate reads its rules through, and the value-level providers
 * that need no file. `policy/reload.ts` builds the file-backed one; this
 * module is what its consumers (`proxy/gate-*`, `session/core.ts`) depend on,
 * so a plain `Policy` and a hot-reloading file look the same from the gate.
 */

export interface PolicyProvider {
  /** The policy in force right now. Synchronous; never touches the file system. */
  current(): Policy
  /**
   * The hot-path check, called by consumers right before a decision. At most
   * once per `POLICY_RECHECK_MIN_MS` it stats the bound file and, on a
   * version change, reads, parses and swaps BEFORE returning — so the
   * decision that asked already sees the edit.
   */
  maybeRefresh(): void
  /** Runs one asynchronous check that STARTS after this call. Never rejects. */
  refresh(): Promise<void>
  /** The file this provider is bound to, or `STATIC_POLICY_SOURCE`. */
  readonly sourcePath: string
}

/** `sourcePath` of a provider that wraps an in-memory value and never reloads. */
export const STATIC_POLICY_SOURCE = '<in-memory>'

function noop(): void {
  // Intentionally empty.
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
    // Read through, never copied: a source that started with no file reports
    // the one it ADOPTED later (`policy/reload-await.ts`), and a wrapper that
    // froze the path it saw at wiring would name the wrong file for good.
    get sourcePath(): string {
      return source.sourcePath
    },
  })
}
