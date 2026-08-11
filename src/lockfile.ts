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
}

/** One acquisition's proof of ownership: where the lock lives and which acquisition it belongs to. */
export interface FileLockHandle {
  readonly lockPath: string
  readonly nonce: string
}

/** 128 bits from the CSPRNG: collisions are not a concern, and the fixed 32-hex width is what keeps a foreign record from ever matching (see `parseLockRecord`). */
const NONCE_BYTES = 16

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
  for (;;) {
    if (await tryCreateLockFile(handle, options.fileMode)) return handle
    if (await stealIfStale(handle, options)) return handle
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

/**
 * Age of the lock, preferring its own recorded `createdAtMs` and falling back
 * to fs mtime for a foreign/legacy lockfile with no parseable content. Known
 * trade-off: `createdAtMs` is the WRITER's clock, so on a shared/NFS journal
 * dir a peer with a lagging clock makes its fresh lock look stale here;
 * server-side mtime is more skew-resistant but loses the record's precision.
 */
async function lockAgeMs(lockPath: string, raw: string): Promise<number | null> {
  const record = parseLockRecord(raw)
  if (record !== null) return Date.now() - record.createdAtMs
  try {
    const stats = await stat(lockPath)
    return Date.now() - stats.mtimeMs
  } catch {
    return null
  }
}

/**
 * Steals a stale lock. Returns `true` iff THIS call now holds the lock (it
 * won the atomic re-create, or there was nothing left to steal and it created
 * fresh); `false` means "someone else owns it and it is not (yet) stale — keep
 * waiting", never "go steal again immediately".
 *
 * The content is re-read immediately before the removal so a lock a concurrent
 * recoverer already re-acquired is not clobbered from under it, and the
 * replacement is created here and nowhere else, so a create that loses the
 * race backs off instead of looping straight into another steal. Both guards
 * narrow the double-steal window; neither closes it, which is what the holder
 * token exists for.
 */
async function stealIfStale(handle: FileLockHandle, options: FileLockOptions): Promise<boolean> {
  const { lockPath } = handle
  const raw = await readLockFileRaw(lockPath)
  if (raw === null) return tryCreateLockFile(handle, options.fileMode) // vanished; claim it

  const age = await lockAgeMs(lockPath, raw)
  if (age === null) return tryCreateLockFile(handle, options.fileMode) // vanished mid-check
  if (age < options.staleMs) return false // held by a live process

  const confirm = await readLockFileRaw(lockPath)
  if (confirm !== raw) return false // someone else already touched it; back off

  await rm(lockPath, { force: true })
  return tryCreateLockFile(handle, options.fileMode)
}
