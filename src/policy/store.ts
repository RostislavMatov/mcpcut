import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../config.js'
import {
  acquireFileLock,
  ownsFileLock,
  releaseFileLock,
  type FileLockHandle,
  type FileLockOptions,
} from '../lockfile.js'

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
  /**
   * Overrides for the lock budgets. A one-shot CLI and a long-lived `serve`
   * do not want the same waits, and tests must not pay a real 5-second
   * acquisition timeout to exercise the contended path.
   */
  readonly lock?: Partial<FileLockOptions>
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
   * never interleave or lose updates. Its return value is what gets persisted
   * (as a deep copy) and is also what this call resolves with. If the current
   * file is corrupt, the update is rejected rather than silently overwriting
   * the corrupt file with a fresh default.
   *
   * `fn` MUST be a pure function of the deep copy it is handed, and MUST
   * tolerate being called more than once (up to `UPDATE_MAX_ATTEMPTS`): when
   * a concurrent recoverer steals the lock mid-flight, the whole cycle is
   * re-run against the value that holder committed, because the snapshot the
   * lost attempt read is no longer current. An `fn` that accumulates into a
   * captured variable, journals, or mints an id as a side effect will observe
   * that replay — keep all of it in the returned value.
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
/** How many times a read-modify-write is re-run after losing the lock to a stale-lock stealer. */
const UPDATE_MAX_ATTEMPTS = 3

const LOCK_OPTIONS: FileLockOptions = {
  totalWaitMs: LOCK_TOTAL_WAIT_MS,
  pollMs: LOCK_POLL_MS,
  staleMs: LOCK_STALE_MS,
  fileMode: JOURNAL_FILE_MODE,
}

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

/**
 * Raised when the lock was acquired but repeatedly stolen before the write
 * could be committed — a different failure from never getting the lock at
 * all, and one worth telling apart in an incident: it means a crash-looping
 * holder or a process manipulating the lockfile, not ordinary contention.
 * Extends `StoreLockError` so existing callers keep catching it.
 */
export class StoreLockLostError extends StoreLockError {
  constructor(filePath: string, attempts: number) {
    super(filePath)
    this.message =
      `Policy store "${filePath}": the lock was stolen before the write could be ` +
      `committed, ${attempts} times in a row; nothing was written`
    this.name = 'StoreLockLostError'
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

/**
 * Creates a store backed by a single JSON file at `filePath`. The parent
 * directory and file share the journal's ownership model: directory 0700,
 * file 0600 (this data — approved tool schemas, quarantine, grants — is as
 * sensitive as the journal itself and is created/chmod'd the same way as
 * `journal/sink.ts`).
 */
export function createJsonStore<T>(filePath: string, opts: JsonStoreOptions<T>): JsonStore<T> {
  const { validate, defaultValue } = opts
  const lockOptions: FileLockOptions = { ...LOCK_OPTIONS, ...opts.lock }

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
    // TS-LOW-1: a rename that fails permanently (retries exhausted) must not
    // leave the uniquely-named tmp file behind forever; clean it up on the
    // failure path only -- a successful rename has already moved it away, so
    // there is nothing left at tmpPath for the (still harmless) force-rm.
    let renamed = false
    try {
      await renameWithRetry(tmpPath, filePath)
      renamed = true
    } finally {
      // The cleanup must never mask the rename rejection that is already
      // propagating (re-review L6): a throwing `rm` in a finally block would
      // replace the original error, hiding the root cause from the caller.
      if (!renamed) await rm(tmpPath, { force: true }).catch(() => undefined)
    }
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
   * Acquires the store lock, sharing ONE budget across every attempt of a
   * single `update()` (`deadlineMs`): a caller that keeps losing the lock must
   * not be able to stall the in-process queue behind it for
   * `UPDATE_MAX_ATTEMPTS` full acquisition waits.
   */
  async function acquireLock(deadlineMs: number): Promise<FileLockHandle> {
    await mkdir(dirname(filePath), { recursive: true, mode: JOURNAL_DIR_MODE })
    const handle = await acquireFileLock(`${filePath}${LOCK_SUFFIX}`, lockOptions, deadlineMs)
    if (handle === null) throw new StoreLockError(filePath)
    return handle
  }

  async function read(): Promise<T> {
    const value = await readValidated()
    return structuredClone(value)
  }

  /**
   * One read-modify-write under the lock, re-run from scratch whenever the
   * lock turns out to have been stolen before the commit: the value read at
   * the start of a lost attempt may already be superseded by the new owner's
   * write, so `fn` must see the current value, not the stale snapshot. An
   * error raised by `fn` is re-checked the same way — reporting "agent not
   * found" computed from a snapshot the code already refuses to WRITE from
   * would be the same staleness bug wearing a different hat.
   *
   * All attempts share one acquisition deadline, so a caller that keeps
   * losing the lock cannot stall the queue behind it for a multiple of
   * `LOCK_TOTAL_WAIT_MS`. Exhausting the attempts throws `StoreLockLostError`
   * and writes nothing.
   */
  async function updateUnderLock(fn: (current: T) => T): Promise<T> {
    const deadlineMs = Date.now() + lockOptions.totalWaitMs
    for (let attempt = 1; attempt <= UPDATE_MAX_ATTEMPTS; attempt += 1) {
      const handle = await acquireLock(deadlineMs)
      try {
        const current = await readValidated()
        let next: T
        try {
          next = fn(structuredClone(current))
        } catch (error: unknown) {
          if (await ownsFileLock(handle)) throw error
          continue
        }
        if (!(await ownsFileLock(handle))) continue
        await writeAtomic(next)
        return structuredClone(next)
      } finally {
        await releaseFileLock(handle)
      }
    }
    throw new StoreLockLostError(filePath, UPDATE_MAX_ATTEMPTS)
  }

  function update(fn: (current: T) => T): Promise<T> {
    const task = queue.then(() => updateUnderLock(fn))

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
