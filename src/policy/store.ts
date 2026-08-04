import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
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

  async function writeAtomic(value: T): Promise<void> {
    const dir = dirname(filePath)
    await mkdir(dir, { recursive: true, mode: JOURNAL_DIR_MODE })
    await chmod(dir, JOURNAL_DIR_MODE)

    const tmpPath = `${filePath}${TMP_SUFFIX}`
    await writeFile(tmpPath, JSON.stringify(value), { encoding: 'utf8', mode: JOURNAL_FILE_MODE })
    await rename(tmpPath, filePath)
  }

  async function read(): Promise<T> {
    const value = await readValidated()
    return structuredClone(value)
  }

  function update(fn: (current: T) => T): Promise<T> {
    const task = queue.then(async () => {
      const current = await readValidated()
      const next = fn(structuredClone(current))
      await writeAtomic(next)
      return structuredClone(next)
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
