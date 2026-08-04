import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../config.js'

/**
 * Atomic, corruption-safe JSON store for policy state (approved tool
 * inventory, quarantine, grants). Deliberately dependency-free: callers
 * inject a `validate` function instead of this module importing a zod
 * schema, so it has no coupling to `src/policy/schema.ts`.
 */

export interface JsonStoreOptions<T> {
  /** Parses/validates the raw JSON value read from disk. Must throw on any invalid shape. */
  readonly validate: (raw: unknown) => T
  /** Returned (as a deep copy) when the store file does not exist yet. */
  readonly defaultValue: T
}

export interface JsonStore<T> {
  /**
   * Missing file → a deep copy of `defaultValue`. Any other failure
   * (unreadable JSON, value that fails `validate`) → rejects with
   * `StoreCorruptError`. Never silently falls back to the default for a
   * file that exists but is bad — a corrupt policy store must be loud, not
   * quietly treated as empty.
   */
  read(): Promise<T>
  /**
   * Read-modify-write, serialized per store instance so concurrent callers
   * never interleave or lose updates. `fn` is treated as a pure function of
   * a deep copy of the current value; its return value is what gets
   * persisted (as a deep copy) and is also what this call resolves with.
   * If the current file is corrupt, the update is rejected rather than
   * silently overwriting the corrupt file with a fresh default.
   */
  update(fn: (current: T) => T): Promise<T>
}

const TMP_SUFFIX = '.tmp'
const LOCK_SUFFIX = '.lock'

/** Cross-process lock acquisition budget before giving up. */
const LOCK_TOTAL_WAIT_MS = 5_000
/** Poll interval while waiting for a held lock to release. */
const LOCK_POLL_MS = 25
/** A lockfile older than this is presumed orphaned (crashed holder) and stolen. */
const LOCK_STALE_MS = 30_000
/** How many times `rename()` is retried when a concurrent writer's rename removed our (uniquely named) tmp — should never collide, but ENOENT is retried defensively. */
const RENAME_MAX_ATTEMPTS = 3

/** Raised by `read()`/`update()` when the store file exists but cannot be trusted. */
export class StoreCorruptError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`Policy store "${filePath}" is corrupt: ${describeCause(cause)}`, { cause })
    this.name = 'StoreCorruptError'
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Raised by `update()` when the cross-process lock could not be acquired in time. */
export class StoreLockError extends Error {
  constructor(filePath: string) {
    super(`Policy store "${filePath}" is locked by another process; timed out acquiring the lock`)
    this.name = 'StoreLockError'
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

function isEnoent(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT')
}

function isEexist(error: unknown): boolean {
  return hasErrorCode(error, 'EEXIST')
}

/**
 * Creates a store backed by a single JSON file at `filePath`. The parent
 * directory and file share the journal's ownership model: directory 0700,
 * file 0600 (this data — approved tool schemas, quarantine, grants — is as
 * sensitive as the journal itself and is created/chmod'd the same way as
 * `journal/sink.ts`).
 */
export function createJsonStore<T>(filePath: string, opts: JsonStoreOptions<T>): JsonStore<T> {
  const { validate, defaultValue } = opts

  /** Serializes every read-modify-write cycle so updates never interleave. */
  let queue: Promise<void> = Promise.resolve()

  async function readValidated(): Promise<T> {
    let text: string
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error: unknown) {
      if (isEnoent(error)) {
        return structuredClone(defaultValue)
      }
      throw new StoreCorruptError(filePath, error)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error: unknown) {
      throw new StoreCorruptError(filePath, error)
    }

    try {
      return validate(parsed)
    } catch (error: unknown) {
      throw new StoreCorruptError(filePath, error)
    }
  }

  /** Per-write unique tmp path so concurrent writers never collide on one `.tmp`. */
  function uniqueTmpPath(): string {
    return `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}${TMP_SUFFIX}`
  }

  async function writeAtomic(value: T): Promise<void> {
    const dir = dirname(filePath)
    await mkdir(dir, { recursive: true, mode: JOURNAL_DIR_MODE })
    await chmod(dir, JOURNAL_DIR_MODE)

    const tmpPath = uniqueTmpPath()
    await writeFile(tmpPath, JSON.stringify(value), { encoding: 'utf8', mode: JOURNAL_FILE_MODE })
    await renameWithRetry(tmpPath, filePath)
  }

  async function renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt += 1) {
      try {
        await rename(from, to)
        return
      } catch (error: unknown) {
        if (!isEnoent(error) || attempt === RENAME_MAX_ATTEMPTS) throw error
        await sleep(LOCK_POLL_MS)
      }
    }
  }

  /**
   * Cross-process advisory lock via an `O_EXCL` lockfile. Node's own async
   * queue only serializes callers sharing this store INSTANCE; two processes
   * (or a proxy session racing the `quarantine approve` CLI) would otherwise
   * do a lost-update read-modify-write. `open(..., 'wx')` fails with EEXIST if
   * the lockfile exists, giving a cheap, cross-platform mutex; a lockfile
   * older than `LOCK_STALE_MS` is presumed orphaned by a crashed holder and
   * stolen so a crash can never wedge the store permanently.
   */
  async function acquireLock(): Promise<string> {
    const dir = dirname(filePath)
    await mkdir(dir, { recursive: true, mode: JOURNAL_DIR_MODE })
    const lockPath = `${filePath}${LOCK_SUFFIX}`
    const deadline = Date.now() + LOCK_TOTAL_WAIT_MS

    for (;;) {
      try {
        const handle = await open(lockPath, 'wx', JOURNAL_FILE_MODE)
        await handle.close()
        return lockPath
      } catch (error: unknown) {
        if (!isEexist(error)) throw error
        if (await stealIfStale(lockPath)) continue
        if (Date.now() >= deadline) throw new StoreLockError(filePath)
        await sleep(LOCK_POLL_MS)
      }
    }
  }

  async function stealIfStale(lockPath: string): Promise<boolean> {
    try {
      const stats = await stat(lockPath)
      if (Date.now() - stats.mtimeMs < LOCK_STALE_MS) return false
      await rm(lockPath, { force: true })
      return true
    } catch {
      // Lock vanished (holder released) between our failed create and this
      // stat: treat as "retry the create" without stealing.
      return true
    }
  }

  async function releaseLock(lockPath: string): Promise<void> {
    await rm(lockPath, { force: true })
  }

  async function read(): Promise<T> {
    const value = await readValidated()
    return structuredClone(value)
  }

  function update(fn: (current: T) => T): Promise<T> {
    const task = queue.then(async () => {
      const lockPath = await acquireLock()
      try {
        const current = await readValidated()
        const next = fn(structuredClone(current))
        await writeAtomic(next)
        return structuredClone(next)
      } finally {
        await releaseLock(lockPath)
      }
    })

    // Keep the queue itself always-resolved so one failed update doesn't
    // permanently wedge the chain for subsequent callers; the rejection is
    // still delivered to whoever awaited this particular `task`.
    queue = task.then(
      () => undefined,
      () => undefined,
    )

    return task
  }

  return { read, update }
}
