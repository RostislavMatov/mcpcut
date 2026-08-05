/**
 * Pure request-id bookkeeping for the session policy gate: a bounded
 * insertion-ordered id set and the exactly-one-outcome answer guard built on
 * it. No JSON-RPC/MCP/policy knowledge lives here — these are plain data
 * structures, split out of `gate-helpers.ts` so each gate module stays under
 * the project's file-size rule.
 */

/**
 * An insertion-ordered id set with a hard entry cap, evicting oldest-first.
 *
 * The gate tracks request ids for the whole life of a session (which ids it
 * answered locally, which are outstanding `tools/list` requests). A client
 * that never stops issuing new ids must not be able to grow that bookkeeping
 * without bound, so the set forgets its oldest entries past `maxEntries` —
 * the same cap-and-evict discipline `journal/record.ts` applies to pending
 * request correlation.
 */
export interface BoundedIdSet {
  add(key: string): void
  has(key: string): boolean
  /** True if `key` was present (and is now removed). */
  delete(key: string): boolean
}

export function createBoundedIdSet(maxEntries: number, onEvict?: (key: string) => void): BoundedIdSet {
  const keys = new Set<string>()

  function evictOldest(): void {
    const oldest = keys.values().next()
    if (oldest.done !== true) {
      keys.delete(oldest.value)
      // Eviction is silent for bookkeeping sets, but the tools/list tracker
      // journals it (M9): a forgotten id means a later tools/list response
      // could escape observation, which an auditor must be able to see.
      onEvict?.(oldest.value)
    }
  }

  return {
    add(key: string): void {
      // Re-adding moves the key to the newest position, so insertion order
      // stays age order and eviction stays "oldest first".
      keys.delete(key)
      // `keys.size > 0` also makes a nonsensical `maxEntries <= 0` terminate.
      while (keys.size >= maxEntries && keys.size > 0) {
        evictOldest()
      }
      keys.add(key)
    },
    has: (key: string): boolean => keys.has(key),
    delete: (key: string): boolean => keys.delete(key),
  }
}

/**
 * The exactly-one-outcome guard for locally-answered request ids (M8).
 *
 * A request id that has been answered locally (a synthetic denial/timeout)
 * must never also be forwarded to the server — not even by a human approval
 * that lands after the wait it was racing. The bulk `answered` set is a
 * bounded LRU (fine for duplicate-response detection), but under a flood of
 * intervening answered ids that LRU can evict the very id an in-flight
 * approval is about to resolve. So ids that are answered *while an approval
 * wait for them is in flight* are also recorded in a separate, non-evicting
 * `burned` set, kept only for the lifetime of that wait (refcounted, cleared
 * when the last wait for the id settles). `isAnswered` consults both.
 */
export interface AnswerGuard {
  /** Records `key` as answered locally; burns it too if a wait is currently in flight for it. */
  markAnswered(key: string): void
  /** True if `key` was ever answered locally (LRU) or burned during an in-flight wait. */
  isAnswered(key: string): boolean
  /** Marks the start of one in-flight approval wait for `key` (refcounted). */
  beginWait(key: string): void
  /** Marks the end of one in-flight approval wait for `key`; clears its burn once no wait remains. */
  endWait(key: string): void
}

export function createAnswerGuard(maxEntries: number): AnswerGuard {
  const answered = createBoundedIdSet(maxEntries)
  const waitCounts = new Map<string, number>()
  const burned = new Set<string>()

  return {
    markAnswered(key: string): void {
      answered.add(key)
      if (waitCounts.has(key)) {
        burned.add(key)
      }
    },
    isAnswered: (key: string): boolean => answered.has(key) || burned.has(key),
    beginWait(key: string): void {
      waitCounts.set(key, (waitCounts.get(key) ?? 0) + 1)
    },
    endWait(key: string): void {
      const next = (waitCounts.get(key) ?? 0) - 1
      if (next <= 0) {
        waitCounts.delete(key)
        burned.delete(key)
      } else {
        waitCounts.set(key, next)
      }
    },
  }
}
