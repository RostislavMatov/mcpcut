import { lstat, readdir, realpath, rename, rm, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fail, failFromErrno, kindOf, succeed, type IoResult } from './io-common.js'
import { hasTrashSegment, isWithinOn } from './names.js'
import {
  isTrashId,
  manifestPath,
  readManifest,
  requireTrashDir,
  type TrashManifest,
} from './trash-manifest.js'

/**
 * The administrator's side of the trash (ADR-0020 §4): list, restore, purge.
 * No agent tool reaches these. An id is a ULID or it is refused before a path
 * is built from it; a manifest is data, so its relative path is re-checked
 * and the destination is rebuilt from the root the admin names.
 */

export interface SkippedEntry {
  readonly id: string
  readonly reason: string
}

export interface TrashListing {
  readonly entries: readonly TrashManifest[]
  readonly skipped: readonly SkippedEntry[]
}

const MANIFEST_NAME = /^([0-9A-HJKMNP-TV-Z]{26})\.json$/

/** Reads every manifest in the root's trash; the corrupt ones are reported in `skipped`. */
export async function listTrash(root: string): Promise<IoResult<TrashListing>> {
  const trash = await requireTrashDir(root)
  if (!trash.ok) return trash
  let names: string[]
  try {
    names = await readdir(trash.value)
  } catch (error: unknown) {
    return failFromErrno(error, 'reading the trash')
  }
  const ids = names.flatMap((name) => MANIFEST_NAME.exec(name)?.[1] ?? []).sort()
  const read = await Promise.all(ids.map(async (id) => ({ id, result: await readManifest(trash.value, id) })))
  const entries = read.flatMap(({ result }) => (result.ok ? [result.value] : []))
  const skipped = read.flatMap(({ id, result }) => (result.ok ? [] : [{ id, reason: result.message }]))
  return succeed({ entries, skipped })
}

function notFoundId(): IoResult<never> {
  return fail('not-found', 'There is no trash entry with that id: list the trash to see the ids.')
}

/** The relative path from a manifest is data: no `..`, no absolute path, no trash name, no empty segment. */
function isSafeRelative(relative: string): boolean {
  if (relative.includes('\u0000') || path.isAbsolute(relative) || hasTrashSegment(relative)) return false
  return relative.split(/[\\/]/).every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

type Destination = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly failure: IoResult<never> }

/** Where a restored entry goes: under the root's real path, in a parent folder that still exists. */
async function destinationOf(root: string, relative: string): Promise<Destination> {
  const corrupt = fail('io-error', 'The manifest points outside the root and was refused: remove the entry by hand after checking it.')
  if (!isSafeRelative(relative)) return { ok: false, failure: corrupt }
  let realRoot: string
  let realParent: string
  try {
    realRoot = await realpath(root)
    realParent = await realpath(path.join(realRoot, path.dirname(relative)))
  } catch {
    return { ok: false, failure: fail('parent-missing', 'The original folder no longer exists: recreate it, then restore again.') }
  }
  const inner = path.relative(realRoot, realParent)
  if (!isWithinOn(realRoot, realParent) || hasTrashSegment(inner)) return { ok: false, failure: corrupt }
  return { ok: true, path: path.join(realParent, path.basename(relative)) }
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(() => true, () => false)
}

/** Puts an entry back at its original path; refuses when something is there now or the folder is gone. */
export async function restoreFromTrash(root: string, id: string): Promise<IoResult<TrashManifest>> {
  if (!isTrashId(id)) return notFoundId()
  const trash = await requireTrashDir(root)
  if (!trash.ok) return trash
  const read = await readManifest(trash.value, id)
  if (!read.ok) return read
  const manifest = read.value
  const destination = await destinationOf(root, manifest.relative)
  if (!destination.ok) return destination.failure
  const stored = path.join(trash.value, id, path.basename(manifest.relative))
  const payload = await lstat(stored, { bigint: true }).catch(() => null)
  if (payload === null) return fail('not-found', 'The trashed item is missing from its trash folder: nothing to restore.')
  if (kindOf(payload) !== manifest.kind) return fail('changed', 'The trashed item is not what the manifest says and was not restored.')
  if (await exists(destination.path)) {
    return fail('exists', 'Something already exists at the original path: move or rename it, then restore again.')
  }
  try {
    await rename(stored, destination.path)
    await unlink(manifestPath(trash.value, id))
    await rmdir(path.join(trash.value, id))
  } catch (error: unknown) {
    return failFromErrno(error, 'restoring it')
  }
  return succeed(manifest)
}

export interface PurgeResult {
  readonly purged: number
  readonly skipped: readonly SkippedEntry[]
}

/** Removes entries and manifests deleted more than `olderThanMs` before `now`; corrupt manifests are skipped and reported. */
export async function purgeTrash(root: string, olderThanMs: number, now: number): Promise<IoResult<PurgeResult>> {
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0 || !Number.isFinite(now)) {
    return fail('io-error', 'The age for purging must be a number of milliseconds, zero or more.')
  }
  const listing = await listTrash(root)
  if (!listing.ok) return listing
  const trash = await requireTrashDir(root)
  if (!trash.ok) return trash
  const cutoff = now - olderThanMs
  const due = listing.value.entries.filter((entry) => Date.parse(entry.deletedAt) < cutoff)
  const outcomes = await Promise.all(due.map((entry) => purgeOne(trash.value, entry.id)))
  const failed = outcomes.flatMap((outcome) => (outcome === null ? [] : [outcome]))
  return succeed({ purged: due.length - failed.length, skipped: [...listing.value.skipped, ...failed] })
}

/** The entry folder first, then its manifest, so a failure in between leaves a manifest to retry from. */
async function purgeOne(trashDir: string, id: string): Promise<SkippedEntry | null> {
  try {
    await rm(path.join(trashDir, id), { recursive: true, force: true })
    await unlink(manifestPath(trashDir, id))
    return null
  } catch (error: unknown) {
    const failure = failFromErrno(error, 'purging the trash')
    return { id, reason: failure.message }
  }
}
