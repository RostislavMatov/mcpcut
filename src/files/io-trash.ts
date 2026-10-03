import { mkdir, rename, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { ulid } from 'ulid'
import { MAX_READ_BYTES } from './constants.js'
import { failFromErrno, fail, kindOf, lstatEntry, parentUnchanged, requireSingleLink, succeed, type IoResult } from './io-common.js'
import { readBytes } from './io-read.js'
import type { ResolvedPath } from './paths.js'
import { requireTrashDir, writeManifest, type TrashManifest } from './trash-manifest.js'

/**
 * Delete is a move (ADR-0020 §4): `rename` into `<root>/.mcpcut-trash/<ulid>/`
 * on the same volume, then a manifest says who, when and from where. Only an
 * administrator restores or purges (`io-trash-admin.ts`).
 */

const ENTRY_DIR_MODE = 0o700

/** The hash of a regular file within the read limit; omitted for bigger or unreadable files, except when the file was swapped. */
async function hashOf(target: ResolvedPath, size: number): Promise<IoResult<string | undefined>> {
  if (size > MAX_READ_BYTES) return succeed(undefined)
  const read = await readBytes(target)
  if (read.ok) return succeed(read.value.sha256)
  return read.problem === 'changed' ? read : succeed(undefined)
}

/** Moves a file or folder to the trash and returns its manifest. */
export async function moveToTrash(target: ResolvedPath, actor: string): Promise<IoResult<TrashManifest>> {
  if (target.exists && target.relative === '') return fail('io-error', 'A root folder cannot be deleted: delete something inside it.')
  const trash = await requireTrashDir(target.root)
  if (!trash.ok) return trash
  const entry = await lstatEntry(target)
  if (!entry.ok) return entry
  const kind = kindOf(entry.value)
  if (kind !== 'file' && kind !== 'directory') {
    return fail('special-file', 'That is not a regular file or folder (a pipe, socket or device) and was refused.')
  }
  const linked = kind === 'file' ? requireSingleLink(entry.value) : null
  const unfit = linked ?? (await parentUnchanged(target))
  if (unfit !== null) return unfit
  const size = kind === 'file' ? Number(entry.value.size) : 0
  const hash = kind === 'file' ? await hashOf(target, size) : succeed(undefined)
  if (!hash.ok) return hash
  const id = ulid()
  const manifest: TrashManifest = {
    id,
    root: target.root,
    relative: target.relative,
    originalPath: target.absolute,
    kind,
    size,
    ...(hash.value === undefined ? {} : { sha256: hash.value }),
    deletedAt: new Date().toISOString(),
    deletedBy: actor,
  }
  return place(target, trash.value, manifest)
}

async function place(target: ResolvedPath, trashDir: string, manifest: TrashManifest): Promise<IoResult<TrashManifest>> {
  const entryDir = path.join(trashDir, manifest.id)
  const stored = path.join(entryDir, path.basename(target.absolute))
  try {
    await mkdir(entryDir, { mode: ENTRY_DIR_MODE })
  } catch (error: unknown) {
    return failFromErrno(error, 'preparing the trash')
  }
  try {
    await rename(target.absolute, stored)
  } catch (error: unknown) {
    await rmdir(entryDir).catch(() => undefined)
    return failFromErrno(error, 'moving it to the trash')
  }
  const written = await writeManifest(trashDir, manifest)
  if (written.ok) return succeed(manifest)
  await rename(stored, target.absolute).then(
    () => rmdir(entryDir),
    () => undefined,
  ).catch(() => undefined)
  return written
}
