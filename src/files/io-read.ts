import { constants, type BigIntStats } from 'node:fs'
import { open, readdir, lstat } from 'node:fs/promises'
import path from 'node:path'
import { MAX_LIST_ENTRIES, MAX_READ_BYTES } from './constants.js'
import {
  O_NOFOLLOW,
  O_NONBLOCK,
  changed,
  failFromErrno,
  fail,
  kindOf,
  lstatEntry,
  matchesHead,
  requireRegularFile,
  sha256Of,
  succeed,
  type EntryKind,
  type IoResult,
} from './io-common.js'
import { hasTrashSegment } from './names.js'
import type { ResolvedPath } from './paths.js'

/**
 * The read side of the file module's I/O layer (ADR-0020 §3.5): what the
 * resolver named is verified against its recorded identity before and after
 * opening, and nothing that is not a regular file is ever opened.
 */

const BINARY_SNIFF_BYTES = 8192

export interface FileBytes {
  readonly bytes: Buffer
  readonly size: number
  readonly sha256: string
  readonly mtime: string
}

export interface TextFile {
  readonly text: string
  readonly size: number
  readonly sha256: string
  readonly mtime: string
}

/** The bytes of a regular file (any content, up to the read limit), opened without following links. */
export async function readBytes(target: ResolvedPath): Promise<IoResult<FileBytes>> {
  const entry = await lstatEntry(target)
  if (!entry.ok) return entry
  const notRegular = requireRegularFile(entry.value)
  if (notRegular !== null) return notRegular
  let handle
  try {
    handle = await open(target.absolute, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error: unknown) {
    return failFromErrno(error, 'opening the file')
  }
  try {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile() || !matchesHead(stats, target)) return changed()
    if (stats.size > BigInt(MAX_READ_BYTES)) {
      return fail('too-large', `The file is larger than ${MAX_READ_BYTES / (1024 * 1024)} MiB and was not read: ask for a smaller file.`)
    }
    const buffer = Buffer.alloc(Number(stats.size))
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    const bytes = buffer.subarray(0, total)
    return succeed({ bytes, size: total, sha256: sha256Of(bytes), mtime: stats.mtime.toISOString() })
  } catch (error: unknown) {
    return failFromErrno(error, 'reading the file')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

const BINARY_MESSAGE = 'The file is binary (not UTF-8 text) and was not read: tools here handle text files only.'

/** UTF-8 text of a regular file; a NUL byte in the first 8 KiB or invalid UTF-8 means binary. */
export async function readText(target: ResolvedPath): Promise<IoResult<TextFile>> {
  const read = await readBytes(target)
  if (!read.ok) return read
  const { bytes, size, sha256, mtime } = read.value
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return fail('binary', BINARY_MESSAGE)
  try {
    // ignoreBOM keeps a byte order mark in the text, so writing it back loses nothing.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    return succeed({ text, size, sha256, mtime })
  } catch {
    return fail('binary', BINARY_MESSAGE)
  }
}

export interface DirectoryEntry {
  readonly name: string
  readonly kind: EntryKind
  readonly size?: number
}

export interface DirectoryListing {
  readonly entries: readonly DirectoryEntry[]
  readonly truncated: boolean
}

async function describeEntry(folder: string, name: string, kind: EntryKind): Promise<DirectoryEntry> {
  if (kind !== 'file') return { name, kind }
  try {
    const stats = await lstat(path.join(folder, name), { bigint: true })
    return stats.isFile() ? { name, kind, size: Number(stats.size) } : { name, kind: 'other' }
  } catch {
    return { name, kind }
  }
}

function compareNames(left: { readonly name: string }, right: { readonly name: string }): number {
  if (left.name === right.name) return 0
  return left.name < right.name ? -1 : 1
}

/** The entries of a folder, sorted, without the trash, capped; the folder is verified before and after reading. */
export async function listDirectory(target: ResolvedPath): Promise<IoResult<DirectoryListing>> {
  const entry = await lstatEntry(target)
  if (!entry.ok) return entry
  if (!entry.value.isDirectory()) return failFromErrno({ code: 'ENOTDIR' }, '')
  let dirents
  try {
    dirents = await readdir(target.absolute, { withFileTypes: true })
  } catch (error: unknown) {
    return failFromErrno(error, 'reading the folder')
  }
  const after = await lstatEntry(target)
  if (!after.ok) return after.problem === 'not-found' ? changed() : after
  const visible = dirents
    .filter((dirent) => !hasTrashSegment(dirent.name))
    .map((dirent) => ({ name: dirent.name, kind: direntKind(dirent) }))
    .sort(compareNames)
  const entries = await Promise.all(visible.slice(0, MAX_LIST_ENTRIES).map((item) => describeEntry(target.absolute, item.name, item.kind)))
  return succeed({ entries, truncated: visible.length > MAX_LIST_ENTRIES })
}

function direntKind(dirent: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryKind {
  if (dirent.isFile()) return 'file'
  if (dirent.isDirectory()) return 'directory'
  return dirent.isSymbolicLink() ? 'symlink' : 'other'
}

export interface FileInfo {
  readonly kind: EntryKind
  readonly size: number
  readonly mtime: string
  readonly nlink: number
}

export async function fileInfo(target: ResolvedPath): Promise<IoResult<FileInfo>> {
  const entry = await lstatEntry(target)
  if (!entry.ok) return entry
  const stats: BigIntStats = entry.value
  return succeed({ kind: kindOf(stats), size: Number(stats.size), mtime: stats.mtime.toISOString(), nlink: Number(stats.nlink) })
}
