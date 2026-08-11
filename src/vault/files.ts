import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../config.js'
import {
  acquireFileLock,
  ownsFileLock,
  releaseFileLock,
  type FileLockOptions,
} from '../lockfile.js'

/**
 * File-level plumbing for the vault store: durable atomic tmp+rename writes,
 * plus the vault's use of the shared lockfile mutex (`src/lockfile.ts`). The
 * STORE is deliberately not shared with `policy/store.ts` — `createJsonStore`
 * owns exactly one file, while a rekey must interleave writes to vault.key and
 * vault.enc in a specific order (see `store.ts`), so these helpers expose the
 * individual steps instead. The LOCK is shared: it is a generic
 * `(lockPath) -> handle` primitive with no bearing on how many files a store
 * owns, and the two hand-rolled copies had already drifted apart.
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

const LOCK_OPTIONS: FileLockOptions = {
  totalWaitMs: LOCK_TOTAL_WAIT_MS,
  pollMs: LOCK_POLL_MS,
  staleMs: LOCK_STALE_MS,
  fileMode: JOURNAL_FILE_MODE,
}

/** Raised when the cross-process lock could not be acquired in time. */
export class VaultLockError extends Error {
  constructor(lockPath: string) {
    super(`vault is locked by another process ("${lockPath}"); timed out acquiring the lock`)
    this.name = 'VaultLockError'
  }
}

/**
 * Raised when the lock was held but had been stolen by the time the operation
 * finished. The work already hit the disk — this says the result cannot be
 * trusted, not that nothing happened. Extends `VaultLockError` so existing
 * callers keep catching it.
 */
export class VaultLockLostError extends VaultLockError {
  constructor(lockPath: string) {
    super(lockPath)
    this.message =
      `vault lock ("${lockPath}") was stolen while the operation was running; ` +
      `the vault may now be inconsistent — verify vault.key and vault.enc before writing again`
    this.name = 'VaultLockLostError'
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
 * Runs `fn` under the shared lockfile mutex (`src/lockfile.ts`): in-process
 * callers of one store instance are additionally serialized by the store's own
 * queue; this lock protects against a *second process* (a `vault set` racing a
 * `serve` session's resolve) doing a lost-update read-modify-write.
 *
 * Unlike the policy store, a lost lock here cannot be recovered by re-running
 * `fn`: it is an arbitrary, order-sensitive sequence — a rekey interleaves
 * `vault.key` and `vault.enc` writes — and replaying it is not safe. So the
 * lock loss is REPORTED instead. Returning `fn`'s value would tell the caller
 * a rekey succeeded while another process wrote the other half of the pair
 * under a different key, leaving `vault.key` of one generation paired with
 * `vault.enc` of another and every secret in the vault undecryptable. A
 * `VaultLockError` after the fact is not a repair, but it is the difference
 * between a loud inconsistency and a silent one.
 */
export async function withVaultLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await ensureDir(dirname(lockPath))
  const handle = await acquireFileLock(lockPath, LOCK_OPTIONS)
  if (handle === null) throw new VaultLockError(lockPath)
  try {
    const result = await fn()
    if (!(await ownsFileLock(handle))) throw new VaultLockLostError(lockPath)
    return result
  } finally {
    await releaseFileLock(handle)
  }
}

