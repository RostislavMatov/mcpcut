import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../config.js'

/**
 * File-level plumbing for the vault store: durable atomic tmp+rename writes
 * and a cross-process lockfile, mirroring `policy/store.ts`. Not shared with
 * that module because `createJsonStore` owns exactly one file per store, while
 * a rekey must interleave writes to vault.key and vault.enc in a specific
 * order (see `store.ts`); these helpers expose the individual steps instead.
 *
 * Durability is not optional here, unlike in the policy store: a rename can
 * reach the disk before the bytes it points at, so a power loss between
 * `vault.key.new`'s rename and its data hitting the platter would leave a
 * staged key that is durable but truncated — and every secret in `vault.enc`
 * permanently unrecoverable. Every write therefore fsyncs the file handle
 * BEFORE the rename and the containing directory AFTER it. At vault-sized
 * files (a key line, one envelope) the cost is irrelevant.
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

/**
 * Reads a file as raw bytes; `null` when it does not exist. Any other failure
 * propagates. The buffer form exists for the master key: a decoded `string`
 * is immutable and lives in the heap until GC decides otherwise, while a
 * Buffer can be zeroized the moment its owner is done with it.
 */
export async function readFileBufferIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error: unknown) {
    if (isEnoent(error)) return null
    throw error
  }
}

/** Reads a file as UTF-8; `null` when it does not exist. Any other failure propagates. */
export async function readFileIfExists(path: string): Promise<string | null> {
  const raw = await readFileBufferIfExists(path)
  return raw === null ? null : raw.toString('utf8')
}

/**
 * Durable atomic write: unique tmp (0600) in the same directory, fsync, then
 * `rename` over the target, then fsync of the directory. The parent directory
 * is created 0700 (vault contents share the journal's ownership model). A
 * failed rename never leaves the tmp behind.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath)
  await ensureDir(dir)
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}${TMP_SUFFIX}`
  let renamed = false
  try {
    await writeAndSync(tmpPath, content)
    await rename(tmpPath, filePath)
    renamed = true
    await syncDir(dir)
  } finally {
    if (!renamed) await rm(tmpPath, { force: true }).catch(() => undefined)
  }
}

/**
 * Renames and makes the new directory entry durable. Used for the rekey's
 * commit steps, where the rename itself IS the transaction boundary.
 */
export async function renameDurable(fromPath: string, toPath: string): Promise<void> {
  await rename(fromPath, toPath)
  await syncDir(dirname(toPath))
}

/** Writes the full content to a fresh 0600 file and flushes it to the device. */
async function writeAndSync(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx', JOURNAL_FILE_MODE)
  try {
    await handle.writeFile(content, { encoding: 'utf8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Flushes a directory entry so a completed rename survives a power loss.
 * Some platforms and filesystems refuse to fsync a directory at all; that is
 * a platform limitation, not a vault failure, so those specific codes are
 * tolerated while anything else (a genuinely missing or unreadable directory)
 * propagates.
 */
const DIR_SYNC_UNSUPPORTED_CODES = ['EPERM', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EACCES', 'EBADF']

async function syncDir(dir: string): Promise<void> {
  let handle
  try {
    handle = await open(dir, 'r')
  } catch (error: unknown) {
    if (DIR_SYNC_UNSUPPORTED_CODES.some((code) => hasErrorCode(error, code))) return
    throw error
  }
  try {
    await handle.sync()
  } catch (error: unknown) {
    if (!DIR_SYNC_UNSUPPORTED_CODES.some((code) => hasErrorCode(error, code))) throw error
  } finally {
    await handle.close()
  }
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: JOURNAL_DIR_MODE })
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_INVALID = 0xff
const BASE64_PAD = '='.charCodeAt(0)
const BITS_PER_BASE64_CHAR = 6
const BITS_PER_BYTE = 8
/** Space, tab, LF, VT, FF, CR — skipped anywhere in the input, like Node's own decoder. */
const ASCII_WHITESPACE = [0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]

const BASE64_DECODE_TABLE = ((): Uint8Array => {
  const table = new Uint8Array(256).fill(BASE64_INVALID)
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index
  }
  return table
})()

/**
 * Decodes base64 straight from bytes to bytes, returning `null` for input
 * that is not base64 at all.
 *
 * `Buffer.from(text, 'base64')` would be shorter, but it needs a `string`
 * first — and a string holding the master key cannot be zeroized, so it would
 * sit in the heap for any memory dump to find. This path never materializes
 * one. It is also strict where Node's decoder is lenient: a stray character
 * is a corrupt key file, not something to silently skip past.
 */
export function decodeBase64Buffer(input: Uint8Array): Buffer | null {
  const output = Buffer.alloc(Math.ceil((input.length * BITS_PER_BASE64_CHAR) / BITS_PER_BYTE))
  let accumulator = 0
  let bits = 0
  let written = 0

  for (const byte of input) {
    if (ASCII_WHITESPACE.includes(byte)) continue
    if (byte === BASE64_PAD) break
    const value = BASE64_DECODE_TABLE[byte]
    if (value === undefined || value === BASE64_INVALID) {
      output.fill(0)
      return null
    }
    accumulator = (accumulator << BITS_PER_BASE64_CHAR) | value
    bits += BITS_PER_BASE64_CHAR
    if (bits >= BITS_PER_BYTE) {
      bits -= BITS_PER_BYTE
      output[written] = (accumulator >> bits) & 0xff
      written += 1
    }
  }
  return output.subarray(0, written)
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
