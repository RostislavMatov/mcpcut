/**
 * The journal read side's cost ceilings and the clamping both carriers apply
 * to a caller's page request.
 *
 * They live in their own module because both arms must obey exactly the same
 * numbers: a page or a walk that means one thing over a `*.jsonl` file and
 * another over `journal.db` would change an operator's answer as a side
 * effect of a migration. `search.ts` re-exports the constants, so callers
 * still get the whole read layer from one import.
 */

/** Page size used when the caller does not ask for one. */
export const DEFAULT_PAGE_LIMIT = 100

/** Largest page any caller can ask for; larger requests are clamped. */
export const MAX_PAGE_LIMIT = 1000

/** Lines one session search may walk before the page is marked truncated. */
export const MAX_SCANNED_LINES_PER_SESSION = 200_000

/** Default hit ceiling for a cross-session search. */
export const CROSS_SESSION_DEFAULT_LIMIT = 200

/** Files a cross-session search may open before it stops. */
export const CROSS_SESSION_MAX_FILES = 50

/** Bytes a cross-session search may read before it stops. */
export const CROSS_SESSION_MAX_BYTES = 64 * 1024 * 1024

/** Wall-clock budget for one cross-session search. */
export const CROSS_SESSION_TIME_BUDGET_MS = 3000

/**
 * Lines between two clock reads inside one file. Checking the deadline on
 * every line would cost a clock call per record; checking only at file
 * boundaries would let one huge file overrun the budget without noticing.
 */
export const DEADLINE_CHECK_LINE_INTERVAL = 500

/** A caller's offset, floored at zero; a nonsensical one reads as none. */
export function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) {
    return 0
  }
  return Math.max(0, Math.floor(offset))
}

/**
 * A caller's page size, clamped into `[1, MAX_PAGE_LIMIT]`. The floor of one
 * matters to the merged cross-session walk: an arm whose remaining budget is
 * zero still collects the single hit that proves there was more.
 */
export function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return fallback
  }
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(limit)))
}
