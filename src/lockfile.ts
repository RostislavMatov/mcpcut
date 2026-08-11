import { randomBytes } from 'node:crypto'
import { open, readFile, rm, stat } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * Cross-process advisory lock over an `O_EXCL` lockfile, shared by the policy
 * store and the vault. Both need the same primitive for the same reason: a
 * second process (a CLI command racing a live `serve` session) would otherwise
 * do a lost-update read-modify-write. `open(..., 'wx')` fails with EEXIST when
 * the file exists, giving a cheap, cross-platform mutex; a lockfile older than
 * `staleMs` is presumed orphaned by a crashed holder and stolen, so a crash
 * can never wedge a store permanently.
 *
 * Previously each store carried its own copy of this logic and the two had
 * already drifted (they disagreed on how to age a lockfile whose record lacked
 * a `pid`), which is why it lives here now. What it deliberately does NOT own
 * is the store semantics on top: the policy store can replay a lost update,
 * the vault cannot, and each keeps its own error type.
 *
 * ## What ownership means here
 *
 * The steal is not race-free and cannot be made so with these primitives: a
 * recoverer that read the stale content just before our create still removes
 * our fresh lock afterwards, so two callers can briefly believe they hold the
 * same lock. Every acquisition therefore stamps a `nonce` — a holder token —
 * and `ownsFileLock` is what separates "we created a lockfile" from "the
 * lockfile out there is still ours". Callers are expected to re-check before
 * acting on the assumption that they still hold it.
 *
 * The nonce is an anti-race token, NOT an authentication token. Any process
 * that can read the lockfile can copy the nonce back into it, so it offers no
 * protection against a hostile same-uid process. The trust boundary is the
 * uid (lockfiles are created 0600); within it, this defends against races and
 * crashes only.
 *
 * ## Emergency recovery of a lock that does not answer for itself
 *
 * A lockfile whose content cannot be trusted — unparseable garbage, or a
 * record whose `createdAtMs` claims freshness the file's own mtime
 * contradicts — must not wedge the store forever: deny/revoke go through
 * `update()`, so write availability is itself a security property, and with
 * M4 there are three writers (CLI, `serve`, UI) able to leave or hit such a
 * lock. The escape is deliberately limited: the lock is removed regardless of
 * content only when its mtime is old enough (`staleMs` for unparseable
 * content, `FORCE_RECOVERY_STALE_FACTOR × staleMs` when a parseable record
 * still claims a live holder) AND unchanged across two observations at least
 * `pollMs` apart. Be honest about what that second condition buys: it
 * excludes only a writer that keeps refreshing the lockfile's mtime while
 * holding it — which no current holder does — so it is a race-narrowing
 * heuristic against a *concurrent recoverer mid-steal*, not proof of
 * abandonment. Correctness under a wrongly stolen lock still rests on the
 * nonce re-check (`ownsFileLock`) in the stores. Every forced removal emits
 * one operator-visible line through the injectable `warn`.
 */

/** Tunables of one lock. Callers own their own budgets: a one-shot CLI and a long-lived `serve` do not want the same waits. */
export interface FileLockOptions {
  /** Total time to spend trying to acquire before giving up. */
  readonly totalWaitMs: number
  /** How long to wait between attempts while another holder is alive. */
  readonly pollMs: number
  /** A lockfile older than this is presumed orphaned and may be stolen. */
  readonly staleMs: number
  /** Mode for the created lockfile. */
  readonly fileMode: number
  /**
   * Receives one operator-visible line whenever a lock that does not answer
   * for itself (unparseable content, or a record contradicted by the file's
   * own mtime) is forcibly removed. Defaults to writing to `process.stderr`;
   * injectable so tests and embedders can capture it.
   */
  readonly warn?: (line: string) => void
}

/** One acquisition's proof of ownership: where the lock lives and which acquisition it belongs to. */
export interface FileLockHandle {
  readonly lockPath: string
  readonly nonce: string
}

/** 128 bits from the CSPRNG: collisions are not a concern, and the fixed 32-hex width is what keeps a foreign record from ever matching (see `parseLockRecord`). */
const NONCE_BYTES = 16

/**
 * Emergency threshold for a lock whose parseable record CLAIMS a live holder
 * (fresh or even future `createdAtMs`) while the file's own mtime says nobody
 * has touched it: removed regardless of content once the mtime is this many
 * staleness windows old and unchanged between checks. More conservative than
 * the plain `staleMs` used for unparseable content, because here the content
 * actively disagrees with the removal.
 *
 * Assumption worth stating: the mtime comparison trusts the FILESYSTEM's
 * clock against this process's `Date.now()`. On a shared/NFS journal dir, or
 * with a filesystem clock skewed by more than ~this factor × `staleMs`
 * (90 s at the defaults), the emergency path can steal a LIVE holder's lock.
 * That does not corrupt the store: the double-hold is caught by the nonce
 * re-check (`ownsFileLock`) before either side commits a write — the skewed
 * setup pays with a retried/failed update, not with a lost one.
 */
export const FORCE_RECOVERY_STALE_FACTOR = 3

/**
 * The lockfile's own content. `pid` is written for operators reading the file
 * during an incident and is deliberately NOT required when parsing — the
 * previous two copies disagreed on exactly this and could return different
 * staleness verdicts for one file.
 */
interface LockRecord {
  readonly createdAtMs: number
  readonly nonce: string
}

function newNonce(): string {
  return randomBytes(NONCE_BYTES).toString('hex')
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

/**
 * Acquires the lock, or resolves `null` when `deadlineMs` passes first — the
 * caller raises its own error type rather than this module inventing one.
 * `deadlineMs` is absolute so a caller that retries can share ONE budget
 * across its attempts instead of granting a fresh `totalWaitMs` to each.
 */
export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions,
  deadlineMs: number = Date.now() + options.totalWaitMs,
): Promise<FileLockHandle | null> {
  const handle: FileLockHandle = { lockPath, nonce: newNonce() }
  // mtime of the foreign lockfile as observed on the PREVIOUS attempt: the
  // emergency recovery only fires when two checks agree the file is untouched.
  let lastMtimeMs: number | null = null
  for (;;) {
    if (await tryCreateLockFile(handle, options.fileMode)) return handle
    const outcome = await stealIfStale(handle, options, lastMtimeMs)
    if (outcome.acquired) return handle
    lastMtimeMs = outcome.observedMtimeMs
    if (Date.now() >= deadlineMs) return null
    await sleep(options.pollMs)
  }
}

/**
 * True only while the lockfile on disk still carries THIS acquisition's nonce.
 * Missing, foreign, unparseable — and any read failure (EACCES, EIO, EMFILE
 * under load) — all answer the same way: we cannot show that we hold it, so we
 * do not. Never throws: every caller asks this question from a `finally` or a
 * commit guard, where an exception would mask a real error or skip a release.
 */
export async function ownsFileLock(handle: FileLockHandle): Promise<boolean> {
  const raw = await readLockFileRaw(handle.lockPath).catch(() => null)
  if (raw === null) return false
  return parseLockRecord(raw)?.nonce === handle.nonce
}

/**
 * Removes the lockfile, but only while it is still ours. A holder whose lock
 * was stolen must not delete the lockfile of whoever took over — that would
 * hand a third caller a lock the new owner still believes it holds. Never
 * throws (see `ownsFileLock`); a lockfile left behind by a failed removal is
 * recovered by the staleness steal.
 */
export async function releaseFileLock(handle: FileLockHandle): Promise<void> {
  if (!(await ownsFileLock(handle))) return
  await rm(handle.lockPath, { force: true }).catch(() => undefined)
}

/** Atomically creates the lockfile with our own ownership record. `false` only on EEXIST. */
async function tryCreateLockFile(handle: FileLockHandle, fileMode: number): Promise<boolean> {
  try {
    const file = await open(handle.lockPath, 'wx', fileMode)
    try {
      const record = { pid: process.pid, createdAtMs: Date.now(), nonce: handle.nonce }
      await file.writeFile(JSON.stringify(record))
    } finally {
      await file.close()
    }
    return true
  } catch (error: unknown) {
    if (hasErrorCode(error, 'EEXIST')) return false
    throw error
  }
}

/** Raw lockfile content, or `null` if it does not exist. */
async function readLockFileRaw(lockPath: string): Promise<string | null> {
  try {
    return await readFile(lockPath, 'utf8')
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) return null
    throw error
  }
}

/**
 * A record without a `nonce` (an older build, or a foreign tool's lockfile)
 * parses with an empty token: it ages and can be stolen like any other, but
 * `ownsFileLock` can never mistake it for ours, since our nonces are always
 * 32 hex characters and `newNonce` is the only source of them.
 */
function parseLockRecord(raw: string): LockRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<LockRecord>
    if (typeof value.createdAtMs !== 'number') return null
    return {
      createdAtMs: value.createdAtMs,
      nonce: typeof value.nonce === 'string' ? value.nonce : '',
    }
  } catch {
    return null
  }
}

/** mtime of the lockfile, or `null` when it vanished mid-check. */
async function lockMtimeMs(lockPath: string): Promise<number | null> {
  try {
    return (await stat(lockPath)).mtimeMs
  } catch {
    return null
  }
}

/**
 * One steal attempt's verdict: either THIS call now holds the lock, or it
 * backs off and reports the foreign lockfile's mtime so the next attempt can
 * tell "untouched since last time" from "a live writer keeps touching it".
 */
type StealOutcome =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly observedMtimeMs: number | null }

/**
 * Steals a stale lock. `acquired: true` iff THIS call now holds the lock (it
 * won the atomic re-create, or there was nothing left to steal and it created
 * fresh); `acquired: false` means "someone else owns it and it is not (yet)
 * stale — keep waiting", never "go steal again immediately".
 *
 * Two paths lead to a removal. The ordinary one trusts the record: a
 * parseable `createdAtMs` past `staleMs` is a crashed holder admitting its
 * own age (known trade-off: `createdAtMs` is the WRITER's clock, so on a
 * shared/NFS journal dir a peer with a lagging clock makes its fresh lock
 * look stale here). The emergency one (`recoverAbandonedLock`) does not trust
 * the content at all and goes by mtime evidence alone — see the module doc.
 */
async function stealIfStale(
  handle: FileLockHandle,
  options: FileLockOptions,
  lastMtimeMs: number | null,
): Promise<StealOutcome> {
  const { lockPath } = handle
  const raw = await readLockFileRaw(lockPath)
  if (raw === null) {
    return (await tryCreateLockFile(handle, options.fileMode))
      ? { acquired: true }
      : { acquired: false, observedMtimeMs: null }
  }

  const mtimeMs = await lockMtimeMs(lockPath)
  if (mtimeMs === null) {
    return (await tryCreateLockFile(handle, options.fileMode))
      ? { acquired: true }
      : { acquired: false, observedMtimeMs: null }
  }

  const record = parseLockRecord(raw)
  if (record !== null && Date.now() - record.createdAtMs >= options.staleMs) {
    // After a removal attempt the earlier mtime describes a file that no
    // longer exists (or was just replaced): observing it would let the NEXT
    // attempt "confirm" abandonment against a stale sighting, so the
    // observation is reset instead of carried over.
    return (await removeAndReclaim(handle, options, raw))
      ? { acquired: true }
      : { acquired: false, observedMtimeMs: null }
  }
  return recoverAbandonedLock(handle, options, { raw, record, mtimeMs, lastMtimeMs })
}

/** Everything a forced-removal decision is based on. */
interface AbandonmentEvidence {
  readonly raw: string
  readonly record: LockRecord | null
  readonly mtimeMs: number
  readonly lastMtimeMs: number | null
}

/**
 * The limited emergency escape: removes a lock REGARDLESS of its content when
 * the file's own mtime is old enough for its trust level AND unchanged across
 * two observations at least `pollMs` apart. That is evidence, not proof (see
 * the module doc): it rules out a writer refreshing the file's mtime — which
 * no current holder does — and otherwise narrows, without closing, the race
 * against a concurrent recoverer; a wrongly stolen lock is caught by the
 * stores' nonce re-check. A changing mtime is treated as a live writer and
 * never stolen, no matter how old the timestamps look: fail closed, at the
 * price of waiting out `totalWaitMs`.
 */
async function recoverAbandonedLock(
  handle: FileLockHandle,
  options: FileLockOptions,
  evidence: AbandonmentEvidence,
): Promise<StealOutcome> {
  const { raw, record, mtimeMs, lastMtimeMs } = evidence
  const factor = record === null ? 1 : FORCE_RECOVERY_STALE_FACTOR
  const notYet: StealOutcome = { acquired: false, observedMtimeMs: mtimeMs }
  const mtimeAgeMs = Date.now() - mtimeMs
  if (mtimeAgeMs < options.staleMs * factor) return notYet // recently touched
  if (mtimeMs !== lastMtimeMs) return notYet // first sighting, or a live writer; look again
  const line = describeForcedRemoval(handle.lockPath, record, mtimeAgeMs)
  // The observation is reset after the attempt: whatever sits at the path now
  // is either our own fresh lock or a rival's — the removed file's mtime must
  // not "confirm" a second removal (see `stealIfStale`).
  return (await removeAndReclaim(handle, options, raw, line))
    ? { acquired: true }
    : { acquired: false, observedMtimeMs: null }
}

/**
 * The only place a foreign lockfile is removed and replaced. The content is
 * re-read immediately before the removal so a lock a concurrent recoverer
 * already re-acquired is not clobbered from under it, and a create that loses
 * the race backs off instead of looping straight into another steal. Both
 * guards narrow the double-steal window; neither closes it, which is what the
 * holder token exists for. `warnLine`, when given, is emitted only once the
 * removal is actually going ahead.
 */
async function removeAndReclaim(
  handle: FileLockHandle,
  options: FileLockOptions,
  expectedRaw: string,
  warnLine?: string,
): Promise<boolean> {
  const confirm = await readLockFileRaw(handle.lockPath)
  if (confirm !== expectedRaw) return false // someone else already touched it; back off
  if (warnLine !== undefined) (options.warn ?? defaultWarn)(warnLine)
  await rm(handle.lockPath, { force: true })
  return tryCreateLockFile(handle, options.fileMode)
}

function defaultWarn(line: string): void {
  process.stderr.write(`${line}\n`)
}

function describeForcedRemoval(
  lockPath: string,
  record: LockRecord | null,
  mtimeAgeMs: number,
): string {
  const reason =
    record === null
      ? 'its content is not a valid lock record'
      : 'its record claims a live holder, but the file itself has not been touched'
  const seconds = Math.round(mtimeAgeMs / 1000)
  return `mcp-journal: removing abandoned lockfile ${lockPath}: ${reason} (mtime unchanged for ${seconds}s); recovering the store`
}
