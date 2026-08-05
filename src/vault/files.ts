import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../config.js'

/**
 * File-level plumbing for the vault store: atomic tmp+rename writes and a
 * cross-process lockfile, mirroring `policy/store.ts`. Not shared with that
 * module because `createJsonStore` owns exactly one file per store, while a
 * rekey must interleave writes to vault.key and vault.enc in a specific order
 * (see `store.ts`); these helpers expose the individual steps instead.
 */

const TMP_SUFFIX = '.tmp'

/** Cross-process lock acquisition budget before giving up. */
const LOCK_TOTAL_WAIT_MS = 5_000
/** Poll interval while waiting for a held lock to release. */
const LOCK_POLL_MS = 25
/** A lockfile older than this is presumed orphaned (crashed holder) and stolen. */
const LOCK_STALE_MS = 30_000

/** Raised when the cross-process lock could not be acquired in time. */
export class VaultLockError extends Error {
  constructor(lockPath: string) {
    super(`vault is locked by another process ("${lockPath}"); timed out acquiring the lock`)
    this.name = 'VaultLockError'
  }
}

export function isEnoent(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT')
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

/** Reads a file as UTF-8; `null` when it does not exist. Any other failure propagates. */
export async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (isEnoent(error)) return null
    throw error
  }
}

/**
 * Atomic write: unique tmp (0600) in the same directory, then `rename` over
 * the target. The parent directory is created 0700 (vault contents share the
 * journal's ownership model). A failed rename never leaves the tmp behind.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await ensureDir(dirname(filePath))
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}${TMP_SUFFIX}`
  await writeFile(tmpPath, content, { encoding: 'utf8', mode: JOURNAL_FILE_MODE })
  let renamed = false
  try {
    await rename(tmpPath, filePath)
    renamed = true
  } finally {
    if (!renamed) await rm(tmpPath, { force: true }).catch(() => undefined)
  }
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: JOURNAL_DIR_MODE })
}

/**
 * Runs `fn` under an `O_EXCL`-lockfile mutex, mirroring `policy/store.ts`:
 * in-process callers of one store instance are additionally serialized by the
 * store's own queue; this lock protects against a *second process* (e.g. a
 * `vault set` racing a `serve` session's resolve) doing a lost-update
 * read-modify-write. A stale lock (crashed holder) is stolen after
 * `LOCK_STALE_MS`, with a content re-check right before the steal so a fresh
 * lock re-acquired by a concurrent recoverer is never clobbered.
 */
export async function withVaultLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await ensureDir(dirname(lockPath))
  const deadline = Date.now() + LOCK_TOTAL_WAIT_MS
  for (;;) {
    if (await tryCreateLockFile(lockPath)) break
    if (await stealIfStale(lockPath)) break
    if (Date.now() >= deadline) throw new VaultLockError(lockPath)
    await sleep(LOCK_POLL_MS)
  }
  try {
    return await fn()
  } finally {
    await rm(lockPath, { force: true })
  }
}

/** Atomically creates the lockfile with an ownership record. `false` only on EEXIST. */
async function tryCreateLockFile(lockPath: string): Promise<boolean> {
  try {
    const handle = await open(lockPath, 'wx', JOURNAL_FILE_MODE)
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }))
    } finally {
      await handle.close()
    }
    return true
  } catch (error: unknown) {
    if (hasErrorCode(error, 'EEXIST')) return false
    throw error
  }
}

/**
 * Steals a stale lock. `true` iff THIS call now holds the lock; `false`
 * means "held by a live process (or just re-acquired by someone else) —
 * keep waiting".
 */
async function stealIfStale(lockPath: string): Promise<boolean> {
  const raw = await readFileIfExists(lockPath)
  if (raw === null) return tryCreateLockFile(lockPath) // vanished; claim it

  const age = await lockAgeMs(lockPath, raw)
  if (age === null) return tryCreateLockFile(lockPath) // vanished between read and stat
  if (age < LOCK_STALE_MS) return false // held by a live process

  // Only steal a lock whose content is still exactly what was judged stale.
  const confirm = await readFileIfExists(lockPath)
  if (confirm !== raw) return false
  await rm(lockPath, { force: true })
  return tryCreateLockFile(lockPath)
}

/** Age from the lock's own record, falling back to fs mtime for foreign content. */
async function lockAgeMs(lockPath: string, raw: string): Promise<number | null> {
  try {
    const record = JSON.parse(raw) as { createdAtMs?: unknown }
    if (typeof record.createdAtMs === 'number') return Date.now() - record.createdAtMs
  } catch {
    // fall through to mtime
  }
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs
  } catch {
    return null
  }
}
