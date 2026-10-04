import { lstat, mkdir, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { ulid } from 'ulid'
import { failFromErrno, fail, kindOf, lstatEntry, parentUnchanged, requireSingleLink, stillAsChecked, succeed, type IoHooks, type IoResult } from './io-common.js'
import { hashRegularFile } from './io-hash.js'
import { relocate, type RelocateKind } from './io-relocate.js'
import type { ResolvedPath } from './paths.js'
import { requireTrashDir, writeManifest, type TrashManifest } from './trash-manifest.js'
import type { FileIdentity } from './identity.js'

/**
 * Delete is a move (ADR-0020 §4): the entry is moved (`relocate`) into
 * `<root>/.mcpcut-trash/<ulid>/` on the same volume, then a manifest says who,
 * when and from where. Only an administrator restores or purges
 * (`io-trash-admin.ts`).
 *
 * Known limit: a crash between the move and the manifest write leaves a
 * payload folder in the trash without a manifest (an orphan). It is invisible
 * to `trash list` and `purge` skips it; an administrator removes it by hand.
 */

const ENTRY_DIR_MODE = 0o700

/** Moves a file or folder to the trash and returns its manifest. */
export async function moveToTrash(target: ResolvedPath, actor: string, hooks: IoHooks = {}): Promise<IoResult<TrashManifest>> {
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
  const id = ulid()
  const identity = { dev: entry.value.dev, ino: entry.value.ino }
  const moved = await place(target, trash.value, id, kind, identity, hooks)
  if (!moved.ok) return moved
  const manifest = await manifestOf(target, actor, id, kind, moved.value)
  return record(target, trash.value, manifest, kind, identity)
}

/** The entry folder, then the move; the folder is removed again when the move does not happen. */
async function place(
  target: ResolvedPath,
  trashDir: string,
  id: string,
  kind: RelocateKind,
  identity: FileIdentity,
  hooks: IoHooks,
): Promise<IoResult<string>> {
  const entryDir = path.join(trashDir, id)
  const stored = path.join(entryDir, path.basename(target.absolute))
  try {
    await mkdir(entryDir, { mode: ENTRY_DIR_MODE })
  } catch (error: unknown) {
    return failFromErrno(error, 'preparing the trash')
  }
  const recheck = async () => {
    await hooks.beforeCommit?.()
    return stillAsChecked(target)
  }
  const moved = await relocate(target.absolute, stored, kind, identity, recheck)
  if (moved.ok) return succeed(stored)
  await rmdir(entryDir).catch(() => undefined)
  return moved
}

/** The manifest of what is stored now: its size and, for a file within the read limit, its hash are taken AFTER the move. */
async function manifestOf(target: ResolvedPath, actor: string, id: string, kind: RelocateKind, stored: string): Promise<TrashManifest> {
  const stats = kind === 'file' ? await lstat(stored, { bigint: true }).catch(() => null) : null
  const sha256 = kind === 'file' ? await hashRegularFile(stored) : undefined
  return {
    id,
    root: target.root,
    relative: target.relative,
    originalPath: target.absolute,
    kind,
    size: stats === null ? 0 : Number(stats.size),
    ...(sha256 === undefined ? {} : { sha256 }),
    deletedAt: new Date().toISOString(),
    deletedBy: actor,
  }
}

/** Writes the manifest; when that fails the entry is moved back (best effort) and the entry folder removed. */
async function record(
  target: ResolvedPath,
  trashDir: string,
  manifest: TrashManifest,
  kind: RelocateKind,
  identity: FileIdentity,
): Promise<IoResult<TrashManifest>> {
  const written = await writeManifest(trashDir, manifest)
  if (written.ok) return succeed(manifest)
  const stored = path.join(trashDir, manifest.id, path.basename(target.absolute))
  const back = await relocate(stored, target.absolute, kind, identity)
  if (back.ok) await rmdir(path.join(trashDir, manifest.id)).catch(() => undefined)
  return written
}
