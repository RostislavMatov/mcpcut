import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { sameIdentity, type ChainEntry } from './identity.js'
import type { ResolvedPath } from './paths.js'

/**
 * Shared parts of the file module's I/O layer (ADR-0020 §3.5): the result
 * type, errno mapping, and the identity checks. Every operation gets a
 * `ResolvedPath` the resolver produced and re-checks it against the identity
 * recorded then, so a path swapped for a symlink in between is `changed`,
 * never followed.
 */

export type IoProblem =
  | 'not-found'
  | 'not-a-file'
  | 'not-a-directory'
  | 'special-file'
  | 'too-large'
  | 'binary'
  | 'exists'
  | 'changed'
  | 'hard-linked'
  | 'edit-mismatch'
  | 'stale'
  | 'parent-missing'
  | 'cross-device'
  | 'no-trash'
  | 'io-error'

export interface IoFailure {
  readonly ok: false
  readonly problem: IoProblem
  readonly message: string
}

export type IoResult<T> = { readonly ok: true; readonly value: T } | IoFailure

/** Windows has no `O_NOFOLLOW`; there the `lstat` checks carry the load. */
export const O_NOFOLLOW: number = constants.O_NOFOLLOW ?? 0

/** A read-only open of a FIFO swapped in after `lstat` returns at once instead of blocking. */
export const O_NONBLOCK: number = constants.O_NONBLOCK ?? 0

export function succeed<T>(value: T): IoResult<T> {
  return { ok: true, value }
}

export function fail(problem: IoProblem, message: string): IoFailure {
  return { ok: false, problem, message }
}

const CHANGED_MESSAGE = 'The path changed after it was checked (it was swapped or replaced) and was refused: look again with list_directory and retry.'

export function changed(): IoFailure {
  return fail('changed', CHANGED_MESSAGE)
}

const NOT_FOUND_MESSAGE = 'Nothing exists at that path: check the name with list_directory.'

export function notFound(): IoFailure {
  return fail('not-found', NOT_FOUND_MESSAGE)
}

/** Maps a thrown error to a problem; the message carries the errno code, never a path. */
export function failFromErrno(error: unknown, action: string): IoFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown'
  switch (code) {
    case 'ENOENT':
      return notFound()
    case 'ENOTDIR':
      return fail('not-a-directory', 'A part of the path is not a folder: check the path with list_directory.')
    case 'EISDIR':
      return fail('not-a-file', 'That path is a folder, not a file: use list_directory to see inside it.')
    case 'ELOOP':
      return changed()
    case 'EEXIST':
    case 'ENOTEMPTY':
      return fail('exists', 'Something already exists at that path: choose another name or look at it with file_info.')
    case 'EXDEV':
      return fail('cross-device', 'The move crosses a drive or mount: copy and delete instead.')
    case 'ENXIO':
    case 'ENODEV':
      return fail('special-file', 'That is not a regular file (a pipe, socket or device) and was refused.')
    default:
      return fail('io-error', `The operating system refused while ${action} (${code}): check permissions and free space, then retry.`)
  }
}

export function sha256Of(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export type EntryKind = 'file' | 'directory' | 'symlink' | 'other'

export function kindOf(stats: BigIntStats): EntryKind {
  if (stats.isFile()) return 'file'
  if (stats.isDirectory()) return 'directory'
  if (stats.isSymbolicLink()) return 'symlink'
  return 'other'
}

/** The identity recorded at resolve time: the target, or its nearest existing ancestor. */
export function headOf(target: ResolvedPath): ChainEntry | undefined {
  return target.chain[0]
}

export function matchesHead(stats: BigIntStats, target: ResolvedPath): boolean {
  const head = headOf(target)
  return head !== undefined && sameIdentity(head, stats)
}

/**
 * `lstat` of an EXISTING target compared with its recorded identity: a
 * vanished path is `not-found`, a symlink or a different inode is `changed`.
 */
export async function lstatEntry(target: ResolvedPath): Promise<IoResult<BigIntStats>> {
  if (!target.exists) return notFound()
  try {
    const stats = await lstat(target.absolute, { bigint: true })
    if (stats.isSymbolicLink() || !matchesHead(stats, target)) return changed()
    return succeed(stats)
  } catch (error: unknown) {
    return failFromErrno(error, 'looking at the path')
  }
}

/** Only a regular file passes: devices, sockets and FIFOs are refused WITHOUT opening them. */
export function requireRegularFile(stats: BigIntStats): IoFailure | null {
  if (stats.isFile()) return null
  if (stats.isDirectory()) return failFromErrno({ code: 'EISDIR' }, '')
  return fail('special-file', 'That is not a regular file (a pipe, socket or device) and was refused.')
}

/** A file whose other hard link may lie outside the root cannot be changed or deleted (ADR-0020 §3.6). */
export function requireSingleLink(stats: BigIntStats): IoFailure | null {
  if (stats.nlink === 1n) return null
  return fail('hard-linked', 'The file has several hard links, so changing or deleting it could touch a file outside your folders; ask an administrator.')
}

/** The target's parent folder (a chain entry) still is the folder recorded at resolve time. */
export async function parentUnchanged(target: ResolvedPath): Promise<IoFailure | null> {
  const parentPath = path.dirname(target.absolute)
  const entry = target.chain.find((candidate) => candidate.path === parentPath)
  if (entry === undefined) return changed()
  try {
    const stats = await lstat(entry.path, { bigint: true })
    return stats.isDirectory() && sameIdentity(entry, stats) ? null : changed()
  } catch (error: unknown) {
    return failFromErrno(error, 'looking at the folder')
  }
}

/**
 * Preconditions of creating something new at `target`: it did not exist, only
 * its last name is missing (the parent is the nearest existing ancestor) and
 * the parent still is the folder that was checked.
 */
export async function checkNewEntry(target: ResolvedPath): Promise<IoFailure | null> {
  if (target.exists) return failFromErrno({ code: 'EEXIST' }, '')
  const head = headOf(target)
  if (head === undefined || path.dirname(target.absolute) !== head.path) {
    return fail('parent-missing', 'The parent folder does not exist: create the folder first with create_directory.')
  }
  try {
    const stats = await lstat(head.path, { bigint: true })
    if (!sameIdentity(head, stats) || stats.isSymbolicLink()) return changed()
    return stats.isDirectory() ? null : failFromErrno({ code: 'ENOTDIR' }, '')
  } catch (error: unknown) {
    return failFromErrno(error, 'looking at the folder')
  }
}

/**
 * Test-only seams of the I/O layer: `beforeCommit` runs right before the
 * identity re-check that precedes every create and rename (where a racing
 * process would act), `afterCommit` right after the create, before it is verified.
 * Production code passes none.
 */
export interface IoHooks {
  readonly beforeCommit?: () => Promise<void>
  readonly afterCommit?: () => Promise<void>
}

/**
 * Run IMMEDIATELY before a rename or a create (ADR-0020 §3.5): the parent
 * folder still is the one that was checked and, when the target exists, it
 * still is the entry that was checked. The window that remains is the few
 * microseconds between this check and the system call; what follows the call
 * (the verification in `io-relocate.ts`, `writeNewFile`) closes it as far as
 * POSIX allows without `openat`.
 */
export async function stillAsChecked(target: ResolvedPath): Promise<IoFailure | null> {
  const parent = await parentUnchanged(target)
  if (parent !== null) return parent
  if (!target.exists) return null
  const entry = await lstatEntry(target)
  return entry.ok ? null : entry
}
