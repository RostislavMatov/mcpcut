import { chmod, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { JOURNAL_DIR, JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../../config.js'
import { mapWithConcurrency } from '../../journal/concurrency.js'
import { redact } from '../../redact/redact.js'
import { canonicalJson, sha256Hex } from '../hash.js'
import type { ToolClass } from '../schema.js'

/**
 * File-based approvals queue: one JSON file per pending/resolved approval
 * request, under `<baseDir>/pending/<approvalId>.json` and
 * `<baseDir>/resolved/<approvalId>.json`. A single directory tree (rather
 * than one shared store file, see `policy/store.ts`) is deliberate: an
 * operator-facing CLI (`approvals list|approve|deny`, Task 18) reads and
 * writes these files directly, and `resolve()`'s correctness depends on
 * `rename()` being the sole serialization point between concurrent
 * resolvers (see `resolve()` doc comment) -- both are simplest with one file
 * per request.
 *
 * Call arguments are stored **only redacted**: this queue file is
 * operator-facing (an approver reads it to decide, and the CLI prints it),
 * so it follows the same "redact before it can be seen" rule as the
 * journal itself.
 */

const APPROVALS_SUBDIR = 'approvals'
const PENDING_SUBDIR = 'pending'
const RESOLVED_SUBDIR = 'resolved'
const TMP_SUFFIX = '.tmp'
const JSON_FILE_SUFFIX = '.json'

// The on-disk file shapes and their validators live in `queue-file.ts`
// (split for the <400-line file rule); re-exported so importers see one module.
export {
  RESOLVE_OUTCOME_VALUES,
  RESOLUTION_OUTCOME_VALUES,
  isPendingApprovalFile,
  isResolvedApprovalFile,
  type ApprovalResolution,
  type PendingApproval,
  type PendingApprovalFile,
  type ResolutionOutcome,
  type ResolveOutcome,
  type ResolvedApprovalFile,
} from './queue-file.js'
import {
  isPendingApprovalFile,
  isResolvedApprovalFile,
  type ApprovalResolution,
  type PendingApproval,
  type PendingApprovalFile,
  type ResolutionOutcome,
  type ResolveOutcome,
  type ResolvedApprovalFile,
} from './queue-file.js'

/** Approval ids are ULIDs; validated before ever being used to build a path. */
const APPROVAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** How many queue files are read at once by `list()`/`listResolved()` (EMFILE bound). */
const QUEUE_READ_CONCURRENCY = 8

/**
 * "Expired" is `now >= expiresAt` — the expiry INSTANT is already expired —
 * on BOTH the list and the resolve path, so an operator can never see a
 * request as live that `resolve()` would downgrade (or vice versa). An
 * unparseable timestamp cannot reach here (`isPendingApprovalFile` rejects
 * it, review H2) but is treated as already expired anyway: fail closed twice.
 */
function isExpiredAt(expiresAt: string, nowMs: number): boolean {
  const expiresAtMs = Date.parse(expiresAt)
  return Number.isNaN(expiresAtMs) || nowMs >= expiresAtMs
}

export interface EnqueueRequest {
  readonly serverName: string
  readonly toolName: string
  readonly toolClass: ToolClass
  /** Raw (unredacted) call arguments. Redacted before ever touching disk. */
  readonly args: unknown
  readonly sessionId: string
  readonly timeoutMs: number
  /** Name of the authenticated agent behind the call; absent on the ad-hoc `wrap` path (M4). */
  readonly agentName?: string
  /** The agent's own wait window; persisted as `waitExpiresAt` when present (M4). */
  readonly waitTimeoutMs?: number
  /** The policy rule that resolved to require-approval (M4). */
  readonly decisionRule?: string
}

export interface EnqueueResult {
  readonly approvalId: string
  readonly argsHash: string
}

export interface ResolveInput {
  readonly outcome: ResolveOutcome
  readonly actor?: string
  readonly reason?: string
}

export type ResolveResult =
  | { readonly ok: true; readonly record: ResolvedApprovalFile }
  | { readonly ok: false; readonly reason: 'not-found-or-already-resolved' }

export interface ListResolvedOptions {
  /** How many of the newest resolved entries to return; only that many files are read. */
  readonly limit: number
}

export interface ApprovalQueue {
  enqueue(req: EnqueueRequest): Promise<EnqueueResult>
  list(): Promise<PendingApproval[]>
  resolve(approvalId: string, resolution: ResolveInput): Promise<ResolveResult>
  /** Records an unresolved approval as `expired`, for session teardown. */
  markExpired(approvalId: string): Promise<ResolveResult>
  /** `null` when the id is unknown or still pending. */
  readResolution(approvalId: string): Promise<ApprovalResolution | null>
  /**
   * The `limit` newest resolved approvals, newest first (M4 UI). File names
   * are ULIDs, so lexicographic order IS chronological order: only the
   * newest `limit` files are ever read, never the whole directory.
   */
  listResolved(opts: ListResolvedOptions): Promise<ResolvedApprovalFile[]>
}

export interface ApprovalQueueOptions {
  /** Root directory for `pending/` and `resolved/`. Defaults to `JOURNAL_DIR/approvals`. */
  readonly baseDir?: string
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  readonly clock?: () => number
  /** Injectable utf8 file reader, so tests can count reads. Defaults to `fs.readFile`. */
  readonly readFileText?: (filePath: string) => Promise<string>
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function isValidApprovalId(approvalId: string): boolean {
  return APPROVAL_ID_PATTERN.test(approvalId)
}

/**
 * Creates a file-based approvals queue rooted at `opts.baseDir`
 * (default `JOURNAL_DIR/approvals`).
 */
export function createApprovalQueue(opts: ApprovalQueueOptions = {}): ApprovalQueue {
  const baseDir = opts.baseDir ?? join(JOURNAL_DIR, APPROVALS_SUBDIR)
  const clock = opts.clock ?? Date.now
  const readFileText = opts.readFileText ?? ((filePath: string) => readFile(filePath, 'utf8'))
  const pendingDir = join(baseDir, PENDING_SUBDIR)
  const resolvedDir = join(baseDir, RESOLVED_SUBDIR)

  function pendingPath(approvalId: string): string {
    return join(pendingDir, `${approvalId}${JSON_FILE_SUFFIX}`)
  }

  function resolvedPath(approvalId: string): string {
    return join(resolvedDir, `${approvalId}${JSON_FILE_SUFFIX}`)
  }

  async function ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: JOURNAL_DIR_MODE })
    await chmod(dir, JOURNAL_DIR_MODE)
  }

  /** Atomic, corruption-safe write: same tmp+rename+0600 discipline as `policy/store.ts`. */
  async function writeAtomic(filePath: string, value: unknown): Promise<void> {
    const tmpPath = `${filePath}${TMP_SUFFIX}`
    await writeFile(tmpPath, JSON.stringify(value), { encoding: 'utf8', mode: JOURNAL_FILE_MODE })
    await rename(tmpPath, filePath)
  }

  /** Reads and JSON-parses a file; `undefined` on ENOENT, throws on any other failure. */
  async function readJsonOrUndefined(filePath: string): Promise<unknown> {
    let text: string
    try {
      text = await readFileText(filePath)
    } catch (error: unknown) {
      if (isEnoent(error)) return undefined
      throw error
    }
    return JSON.parse(text)
  }

  async function enqueue(req: EnqueueRequest): Promise<EnqueueResult> {
    await ensureDir(pendingDir)
    await ensureDir(resolvedDir)

    const approvalId = ulid()
    const argsForHashing = req.args ?? null
    const argsHash = sha256Hex(canonicalJson(argsForHashing))
    const nowMs = clock()

    const record: PendingApprovalFile = {
      approvalId,
      serverName: req.serverName,
      toolName: req.toolName,
      toolClass: req.toolClass,
      argsRedacted: redact(argsForHashing),
      argsHash,
      sessionId: req.sessionId,
      requestedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + req.timeoutMs).toISOString(),
      ...(req.agentName !== undefined ? { agentName: req.agentName } : {}),
      ...(req.waitTimeoutMs !== undefined
        ? { waitExpiresAt: new Date(nowMs + req.waitTimeoutMs).toISOString() }
        : {}),
      ...(req.decisionRule !== undefined ? { decisionRule: req.decisionRule } : {}),
    }

    await writeAtomic(pendingPath(approvalId), record)
    return { approvalId, argsHash }
  }

  async function list(): Promise<PendingApproval[]> {
    let entries: string[]
    try {
      entries = await readdir(pendingDir)
    } catch (error: unknown) {
      if (isEnoent(error)) return []
      throw error
    }

    const jsonEntries = entries.filter((name) => name.endsWith(JSON_FILE_SUFFIX))
    const nowMs = clock()
    const reads = await mapWithConcurrency(jsonEntries, QUEUE_READ_CONCURRENCY, async (name) => {
      let raw: unknown
      try {
        raw = await readJsonOrUndefined(join(pendingDir, name))
      } catch {
        return null // malformed JSON: skip
      }
      if (!isPendingApprovalFile(raw)) return null // malformed shape: skip
      return { ...raw, expired: isExpiredAt(raw.expiresAt, nowMs) }
    })

    return reads
      .filter((entry): entry is PendingApproval => entry !== null)
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
  }

  /**
   * Moves `pending/<approvalId>.json` to `resolved/<approvalId>.json` via
   * `rename()`, then overwrites the resolved file with the resolution
   * attached. `rename()` is the serialization point: the OS guarantees at
   * most one caller can successfully rename a given source path, so of two
   * concurrent resolvers racing the same id, exactly one observes success
   * here and "owns" the resolved file; the other sees ENOENT (the source is
   * already gone) and reports `not-found-or-already-resolved`. The pending
   * content is read *before* the rename purely to avoid a second read after
   * we already own the file; `rename()` never touches file content, so
   * reading first is safe even under the race.
   */
  async function moveToResolved(
    approvalId: string,
    buildResolution: (pending: PendingApprovalFile) => Omit<ApprovalResolution, 'resolvedAt'>,
  ): Promise<ResolveResult> {
    if (!isValidApprovalId(approvalId)) {
      return { ok: false, reason: 'not-found-or-already-resolved' }
    }

    let raw: unknown
    try {
      raw = await readJsonOrUndefined(pendingPath(approvalId))
    } catch {
      raw = undefined // malformed pending file: treat as not-found
    }
    if (!isPendingApprovalFile(raw)) {
      return { ok: false, reason: 'not-found-or-already-resolved' }
    }
    const pending = raw

    await ensureDir(resolvedDir)
    try {
      await rename(pendingPath(approvalId), resolvedPath(approvalId))
    } catch (error: unknown) {
      if (isEnoent(error)) {
        return { ok: false, reason: 'not-found-or-already-resolved' }
      }
      throw error
    }

    // We own resolvedPath(approvalId) now: no other caller can have won this rename.
    const record: ResolvedApprovalFile = {
      ...pending,
      resolution: buildResolution(pending),
      resolvedAt: new Date(clock()).toISOString(),
    }
    await writeAtomic(resolvedPath(approvalId), record)
    return { ok: true, record }
  }

  /**
   * Records an operator resolution. Time-aware for `approved`: if the request
   * has already passed its `expiresAt`, the session it was for is dead and a
   * late `approved` would let `checkRecentApproval` mint a grant for a
   * finished session. Such a stale approval is DOWNGRADED to `expired` (the
   * operator's `actor`/`reason` are preserved for the audit trail) so no
   * `approved` resolution is ever written past expiry. A `denied` on a stale
   * request is harmless and is recorded as-is.
   */
  function resolve(approvalId: string, resolution: ResolveInput): Promise<ResolveResult> {
    const nowMs = clock()
    return moveToResolved(approvalId, (pending) => {
      const expired = isExpiredAt(pending.expiresAt, nowMs)
      const outcome: ResolutionOutcome =
        expired && resolution.outcome === 'approved' ? 'expired' : resolution.outcome
      return {
        outcome,
        ...(resolution.actor !== undefined ? { actor: resolution.actor } : {}),
        ...(resolution.reason !== undefined ? { reason: resolution.reason } : {}),
      }
    })
  }

  function markExpired(approvalId: string): Promise<ResolveResult> {
    return moveToResolved(approvalId, () => ({ outcome: 'expired' }))
  }

  async function readResolution(approvalId: string): Promise<ApprovalResolution | null> {
    if (!isValidApprovalId(approvalId)) return null

    let raw: unknown
    try {
      raw = await readJsonOrUndefined(resolvedPath(approvalId))
    } catch {
      return null // malformed JSON: never throw on garbage disk content
    }
    if (raw === undefined) return null // still pending or unknown id
    if (!isResolvedApprovalFile(raw)) return null // malformed shape

    return {
      outcome: raw.resolution.outcome,
      ...(raw.resolution.actor !== undefined ? { actor: raw.resolution.actor } : {}),
      ...(raw.resolution.reason !== undefined ? { reason: raw.resolution.reason } : {}),
      resolvedAt: raw.resolvedAt,
    }
  }

  /** See `ApprovalQueue.listResolved`: bounded read of the newest entries only. */
  async function listResolved(listOpts: ListResolvedOptions): Promise<ResolvedApprovalFile[]> {
    if (!Number.isInteger(listOpts.limit) || listOpts.limit <= 0) return []

    let entries: string[]
    try {
      entries = await readdir(resolvedDir)
    } catch (error: unknown) {
      if (isEnoent(error)) return []
      throw error
    }

    // ULID file names: lexicographic descending == newest first. Only the
    // first `limit` names are ever opened; a malformed file among them is
    // skipped, not backfilled from older entries (the read stays bounded).
    const newestNames = entries
      .filter((name) => name.endsWith(JSON_FILE_SUFFIX))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, listOpts.limit)

    const reads = await mapWithConcurrency(newestNames, QUEUE_READ_CONCURRENCY, async (name) => {
      let raw: unknown
      try {
        raw = await readJsonOrUndefined(join(resolvedDir, name))
      } catch {
        return null // malformed JSON: skip
      }
      return isResolvedApprovalFile(raw) ? raw : null // malformed shape: skip
    })
    return reads.filter((entry): entry is ResolvedApprovalFile => entry !== null)
  }

  return { enqueue, list, resolve, markExpired, readResolution, listResolved }
}
