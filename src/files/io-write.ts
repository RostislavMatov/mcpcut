import type { BigIntStats } from 'node:fs'
import { constants } from 'node:fs'
import { lstat, open, rename, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { ulid } from 'ulid'
import { MAX_WRITE_BYTES } from './constants.js'
import { sameIdentity } from './identity.js'
import {
  O_NOFOLLOW,
  changed,
  checkNewEntry,
  fail,
  failFromErrno,
  lstatEntry,
  parentUnchanged,
  requireRegularFile,
  requireSingleLink,
  sha256Of,
  succeed,
  type IoResult,
} from './io-common.js'
import { readBytes, readText } from './io-read.js'
import type { ResolvedPath } from './paths.js'

export { makeDirectory, moveEntry } from './io-move.js'

/**
 * The write side of the file module's I/O layer (ADR-0020 §3.5-3.6): a new
 * file is created with O_EXCL; an existing one is changed by writing a temp
 * file beside it and `rename` — which replaces a symlink swapped in at the
 * target instead of following it. The caller has checked the rights.
 */

export interface WriteInfo {
  readonly sha256: string
  readonly size: number
}

export interface TextEdit {
  readonly oldText: string
  readonly newText: string
}

const TEMP_PREFIX = '.mcpcut-tmp-'
const NEW_FILE_MODE = 0o644
const TEMP_FILE_MODE = 0o600
const PERMISSION_BITS = 0o777
const CREATE_EXCLUSIVE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW

function tooLarge(): IoResult<never> {
  return fail('too-large', `The content is larger than ${MAX_WRITE_BYTES / (1024 * 1024)} MiB and was not written: split it into smaller files.`)
}

/** Creates a file that does not exist yet; refuses an existing path and a missing parent. */
export async function writeNewFile(target: ResolvedPath, content: string): Promise<IoResult<WriteInfo>> {
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.length > MAX_WRITE_BYTES) return tooLarge()
  const unfit = await checkNewEntry(target)
  if (unfit !== null) return unfit
  let handle
  try {
    handle = await open(target.absolute, CREATE_EXCLUSIVE, NEW_FILE_MODE)
  } catch (error: unknown) {
    return failFromErrno(error, 'creating the file')
  }
  let created: BigIntStats
  try {
    created = await handle.stat({ bigint: true })
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error: unknown) {
    await handle.close().catch(() => undefined)
    await unlink(target.absolute).catch(() => undefined)
    return failFromErrno(error, 'writing the file')
  }
  await handle.close()
  const swapped = await parentUnchanged(target)
  if (swapped !== null) {
    await removeIfSame(target.absolute, created)
    return swapped
  }
  return succeed({ sha256: sha256Of(bytes), size: bytes.length })
}

/** Removes `file` only when it still is the very file just created (a swapped parent must not cost someone else's file). */
async function removeIfSame(file: string, created: BigIntStats): Promise<void> {
  try {
    const now = await lstat(file, { bigint: true })
    if (sameIdentity(now, created)) await unlink(file)
  } catch {
    // The file is gone or unreadable: nothing of ours is left to remove at that path.
  }
}

/** Overwrites an existing regular file; with `expectedSha256` only if its content still is what the caller saw. */
export async function replaceFile(
  target: ResolvedPath,
  content: string,
  expectedSha256?: string,
): Promise<IoResult<WriteInfo>> {
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.length > MAX_WRITE_BYTES) return tooLarge()
  const entry = await lstatEntry(target)
  if (!entry.ok) return entry
  const unfit = requireRegularFile(entry.value) ?? requireSingleLink(entry.value)
  if (unfit !== null) return unfit
  if (expectedSha256 !== undefined) {
    const current = await readBytes(target)
    if (!current.ok) return current
    if (current.value.sha256 !== expectedSha256.toLowerCase()) return staleResult()
  }
  const temp = path.join(path.dirname(target.absolute), `${TEMP_PREFIX}${ulid()}`)
  const written = await writeTemp(target, temp, bytes, entry.value, expectedSha256 !== undefined)
  if (!written.ok) await rm(temp, { force: true }).catch(() => undefined)
  return written
}

function staleResult(): IoResult<never> {
  return fail('stale', 'The file changed since you read it: read it again and redo the change.')
}

async function writeTemp(
  target: ResolvedPath,
  temp: string,
  bytes: Buffer,
  before: BigIntStats,
  isGuarded: boolean,
): Promise<IoResult<WriteInfo>> {
  let handle
  try {
    handle = await open(temp, CREATE_EXCLUSIVE, TEMP_FILE_MODE)
  } catch (error: unknown) {
    return failFromErrno(error, 'creating a temporary file')
  }
  try {
    await handle.writeFile(bytes)
    await handle.chmod(Number(before.mode) & PERMISSION_BITS)
    await handle.sync()
  } catch (error: unknown) {
    return failFromErrno(error, 'writing the file')
  } finally {
    await handle.close().catch(() => undefined)
  }
  const unfit = await unchangedSince(target, before, isGuarded)
  if (unfit !== null) return unfit
  try {
    await rename(temp, target.absolute)
  } catch (error: unknown) {
    return failFromErrno(error, 'replacing the file')
  }
  return succeed({ sha256: sha256Of(bytes), size: bytes.length })
}

/** Just before `rename`: the target and its folder still are what was checked (and, if guarded, untouched since). */
async function unchangedSince(target: ResolvedPath, before: BigIntStats, isGuarded: boolean): Promise<IoResult<never> | null> {
  const parent = await parentUnchanged(target)
  if (parent !== null) return parent
  const now = await lstatEntry(target)
  if (!now.ok) return now
  if (now.value.nlink !== 1n) return requireSingleLink(now.value)
  const isTouched = now.value.mtimeNs !== before.mtimeNs || now.value.size !== before.size
  return isGuarded && isTouched ? staleResult() : null
}

function countOccurrences(text: string, needle: string): number {
  let count = 0
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) count += 1
  return count
}

/** Applies each edit in order; `oldText` must occur exactly once in the text as it is at that step. */
function applyEdits(text: string, edits: readonly TextEdit[]): IoResult<string> {
  if (edits.length === 0) return fail('edit-mismatch', 'No edits were given: pass at least one {oldText, newText}.')
  let current = text
  for (const [index, edit] of edits.entries()) {
    if (edit.oldText === '') return fail('edit-mismatch', `Edit ${index}: oldText is empty; give the exact text to replace.`)
    const count = countOccurrences(current, edit.oldText)
    if (count !== 1) {
      const hint = count === 0 ? 'read the file again and copy the text exactly' : 'add more surrounding text so it matches once'
      return fail('edit-mismatch', `Edit ${index}: oldText was found ${count} times, it must be found exactly once: ${hint}.`)
    }
    const at = current.indexOf(edit.oldText)
    current = current.slice(0, at) + edit.newText + current.slice(at + edit.oldText.length)
  }
  return succeed(current)
}

/** Replaces exact text in a text file, all edits or none; a change made meanwhile makes it `stale`. */
export async function editFile(
  target: ResolvedPath,
  edits: readonly TextEdit[],
  expectedSha256?: string,
): Promise<IoResult<WriteInfo>> {
  const read = await readText(target)
  if (!read.ok) return read
  if (expectedSha256 !== undefined && read.value.sha256 !== expectedSha256.toLowerCase()) return staleResult()
  const edited = applyEdits(read.value.text, edits)
  if (!edited.ok) return edited
  return replaceFile(target, edited.value, read.value.sha256)
}
