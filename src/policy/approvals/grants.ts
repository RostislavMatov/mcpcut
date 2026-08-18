import {
  DEFAULT_GRANT_TTL_MS,
  GRANT_CLOCK_SKEW_MS,
  RESOLVED_FILE_RETENTION_MS,
} from '../constants.js'
import { isOptionalActor } from './queue-file.js'
import {
  deleteResolvedOlderThan,
  openApprovalsDb,
  selectResolvedDocsForGrant,
  type ApprovalsDb,
} from './queue-db.js'

/**
 * Two-tier grant design.
 *
 * A "grant" lets a retried `tools/call` skip a fresh approval prompt when an
 * identical call (same server, tool, and args) was approved recently. There
 * are two tiers because a grant can be needed in two different situations:
 *
 * 1. **Fast path -- `createGrantRegistry` (in-memory).** The common case: the
 *    gate is still polling `approvals/waiter.ts` for this exact call when it
 *    resolves `'approved'`. The gate records the grant here and the retry
 *    (same proxy session, moments later) is a synchronous map lookup -- no
 *    disk I/O.
 * 2. **Late-approval fallback -- `checkRecentApproval` (storage-backed).** An
 *    operator can approve a request *after* its wait already timed out (the
 *    gate stopped polling and already answered the client with a timeout
 *    error). The gate has no in-memory record of that late approval, but the
 *    approvals queue does: `queue.resolve()` already recorded it as a resolved
 *    row in `state.db`. When the agent retries the same call, the gate
 *    checks `checkRecentApproval` before enqueueing a brand new approval, so
 *    one manual approval is enough even if the agent's first attempt already
 *    gave up.
 *
 * In-memory grants are per-session and are lost on process restart by
 * design -- M2 does not need cross-process grant persistence, only "the
 * retry that immediately follows an approval succeeds without asking twice",
 * and `checkRecentApproval` already covers the case that matters (a
 * *slower* retry, arriving after the in-process wait gave up).
 */

/**
 * Max rows this call will delete for retention. Bounds cleanup cost per call so
 * it amortizes over many calls instead of one long delete on the hot path.
 */
const RETENTION_CLEANUP_BATCH = 200

/**
 * Max resolved records considered for one grant decision. The query is already
 * narrowed to a single (server, tool, args) triple by index and ordered newest
 * first, and only a resolution inside the TTL window can grant, so anything
 * past the newest few is necessarily too old to matter.
 */
const MAX_GRANT_CANDIDATES = 50

export interface GrantKey {
  readonly serverName: string
  readonly toolName: string
  readonly argsHash: string
}

export interface GrantRegistry {
  /** Records that `key` is granted for `ttlMs` milliseconds from now. */
  grant(key: GrantKey, ttlMs?: number): void
  /** True if `key` has an unexpired grant. Expired entries are evicted on lookup. */
  isGranted(key: GrantKey): boolean
}

export interface GrantRegistryOptions {
  /** Injectable clock for deterministic TTL tests. Defaults to `Date.now`. */
  readonly clock?: () => number
}

function keyOf(key: GrantKey): string {
  return `${key.serverName}\u0000${key.toolName}\u0000${key.argsHash}`
}

/** In-memory grant fast path. See module doc comment for the two-tier design. */
export function createGrantRegistry(opts: GrantRegistryOptions = {}): GrantRegistry {
  const clock = opts.clock ?? Date.now
  const expiresAtByKey = new Map<string, number>()

  function grant(key: GrantKey, ttlMs: number = DEFAULT_GRANT_TTL_MS): void {
    expiresAtByKey.set(keyOf(key), clock() + ttlMs)
  }

  function isGranted(key: GrantKey): boolean {
    const id = keyOf(key)
    const expiresAtMs = expiresAtByKey.get(id)
    if (expiresAtMs === undefined) return false
    if (clock() >= expiresAtMs) {
      expiresAtByKey.delete(id)
      return false
    }
    return true
  }

  return { grant, isGranted }
}

/**
 * Minimal shape `checkRecentApproval` needs from a resolved record; validated
 * field-by-field so garbage stored content is skipped, never thrown.
 *
 * `resolution.actor` is part of that minimum since M5 wave 2: the retry this
 * record admits writes a journal record naming the operator, so the name has
 * to survive the same validation as everything else it is decided on.
 */
interface ResolvedFileForGrantCheck {
  readonly approvalId: string
  readonly serverName: string
  readonly toolName: string
  readonly argsHash: string
  readonly resolvedAt: string
  readonly resolution: { readonly outcome: string; readonly actor?: string }
}

function isResolvedFileForGrantCheck(raw: unknown): raw is ResolvedFileForGrantCheck {
  if (typeof raw !== 'object' || raw === null) return false
  const value = raw as Record<string, unknown>
  const resolution = value.resolution
  return (
    typeof value.approvalId === 'string' &&
    typeof value.serverName === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.argsHash === 'string' &&
    typeof value.resolvedAt === 'string' &&
    typeof resolution === 'object' &&
    resolution !== null &&
    typeof (resolution as Record<string, unknown>).outcome === 'string' &&
    // The SAME optional-and-length-capped check the queue's own validator
    // applies (`queue-file.ts`), not a looser local copy: this path never
    // goes through `isResolvedApprovalFile`, so a second, weaker rule here
    // would be the hole the cap exists to close.
    isOptionalActor((resolution as Record<string, unknown>).actor)
  )
}

/**
 * What a late approval grants: the identifying facts of the resolution that
 * authorized it, so the record written for the retry can name them.
 *
 * An object rather than a boolean because the retry's journal record used to
 * say only `allow` / `rule: grant` — a destructive call succeeding with the
 * human approval behind it recorded nowhere, which is unreadable as evidence
 * (M5 wave 2). `actor` is ABSENT when the resolution named nobody; the whole
 * value is `null` — never a falsy-but-present object — when nothing grants,
 * so "no grant" stays one unambiguous check at the call site.
 */
export interface RecentApprovalGrant {
  readonly approvalId: string
  readonly actor?: string
}

export interface CheckRecentApprovalInput extends GrantKey {
  readonly ttlMs: number
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  readonly clock?: () => number
}

/**
 * Storage-backed fallback for a late approval (see module doc comment). One
 * indexed lookup on `(serverName, toolName, argsHash)` over the resolved rows
 * of the queue (M4.5 wave 3; before that, a directory scan of up to two
 * thousand files that cost hundreds of ms on a never-pruned directory).
 * Returns the identifying facts of the FIRST record with
 * `outcome === 'approved'` whose `resolvedAt` is within `ttlMs` of now and not
 * in the future (skew-guarded), and `null` when nothing matches.
 *
 * NEVER throws and NEVER blocks the decision on storage health: this sits on
 * the gate's hot path, where a failure to read must fall back to asking a human
 * (`null`), never to granting. Malformed records are skipped the same way.
 * Opportunistically prunes a bounded batch of records settled longer ago than
 * `RESOLVED_FILE_RETENTION_MS`.
 */
export async function checkRecentApproval(
  baseDir: string,
  input: CheckRecentApprovalInput,
): Promise<RecentApprovalGrant | null> {
  const clock = input.clock ?? Date.now
  const nowMs = clock()

  let db: ApprovalsDb
  let docs: readonly string[]
  try {
    db = await openApprovalsDb(baseDir)
    docs = selectResolvedDocsForGrant(db.handle.db, input, MAX_GRANT_CANDIDATES)
  } catch {
    return null // unopenable or unreadable storage: no grant, ask a human
  }

  const matched = firstGrant(docs, input, nowMs)
  // Retention runs whether or not anything matched, exactly as before.
  pruneOldResolvedRows(db, nowMs)
  return matched
}

/** The first candidate document that grants, as its identifying facts; `null` if none does. */
function firstGrant(
  docs: readonly string[],
  input: CheckRecentApprovalInput,
  nowMs: number,
): RecentApprovalGrant | null {
  for (const doc of docs) {
    const record = matchesGrant(doc, input, nowMs)
    if (record !== null) {
      return record.resolution.actor !== undefined
        ? { approvalId: record.approvalId, actor: record.resolution.actor }
        : { approvalId: record.approvalId }
    }
  }
  return null
}

/**
 * Decides one record. Every criterion is re-checked against the stored
 * document even though the query already filtered on the indexed copies: the
 * `doc` column is the source of truth, and a row whose flat columns disagree
 * with it must not be able to mint a grant its own record does not support.
 */
function matchesGrant(
  doc: string,
  input: CheckRecentApprovalInput,
  nowMs: number,
): ResolvedFileForGrantCheck | null {
  let raw: unknown
  try {
    raw = JSON.parse(doc)
  } catch {
    return null // invalid JSON: skip
  }
  if (!isResolvedFileForGrantCheck(raw)) return null

  if (raw.resolution.outcome !== 'approved') return null
  if (raw.serverName !== input.serverName) return null
  if (raw.toolName !== input.toolName) return null
  if (raw.argsHash !== input.argsHash) return null

  const resolvedAtMs = Date.parse(raw.resolvedAt)
  if (Number.isNaN(resolvedAtMs)) return null
  // Reject a future-dated resolution (backdated/forged clock): a grant may only
  // come from an approval that already happened, within the TTL window.
  if (resolvedAtMs > nowMs + GRANT_CLOCK_SKEW_MS) return null
  return nowMs - resolvedAtMs <= input.ttlMs ? raw : null
}

/**
 * Best-effort retention: deletes up to `RETENTION_CLEANUP_BATCH` of the oldest
 * records settled longer than `RESOLVED_FILE_RETENTION_MS` ago (well past any
 * grant TTL), so resolved history cannot grow without bound across a long-lived
 * session. ONE transaction attempt, bounded by the statement busy timeout
 * (~50 ms) — never the multi-second busy-retry loop the queue's own writes
 * use: this runs on the gate's hot path, and a contended writer is somebody
 * else's approval landing, so this call simply skips the cleanup and a later
 * call retries it. Never throws.
 */
function pruneOldResolvedRows(db: ApprovalsDb, nowMs: number): void {
  const cutoffIso = new Date(nowMs - RESOLVED_FILE_RETENTION_MS).toISOString()
  try {
    db.handle.transaction((database) =>
      deleteResolvedOlderThan(database, cutoffIso, RETENTION_CLEANUP_BATCH),
    )
  } catch {
    // Locked, or gone: retention is opportunistic and never fails a decision.
  }
}
