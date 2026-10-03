import { mkdir, lstat, rename, rmdir } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import {
  checkNewEntry,
  fail,
  failFromErrno,
  kindOf,
  lstatEntry,
  parentUnchanged,
  requireSingleLink,
  succeed,
  type IoResult,
} from './io-common.js'
import { isWithinOn } from './names.js'
import type { ResolvedPath } from './paths.js'

/** Creating a folder and moving an entry (ADR-0020 §3): same identity rules as for files. */

const DIRECTORY_MODE = 0o755

/** Creates one folder (not recursive); the parent must exist and stay the folder that was checked. */
export async function makeDirectory(target: ResolvedPath): Promise<IoResult<null>> {
  const unfit = await checkNewEntry(target)
  if (unfit !== null) return unfit
  try {
    await mkdir(target.absolute, { mode: DIRECTORY_MODE })
  } catch (error: unknown) {
    return failFromErrno(error, 'creating the folder')
  }
  const swapped = await parentUnchanged(target)
  if (swapped === null) return succeed(null)
  await removeEmptyIfNew(target.absolute)
  return swapped
}

/** Best effort after a swapped parent: remove the folder only if it is empty and not one that existed before. */
async function removeEmptyIfNew(folder: string): Promise<void> {
  try {
    const stats: BigIntStats = await lstat(folder, { bigint: true })
    if (stats.isDirectory()) await rmdir(folder)
  } catch {
    // Already gone or not empty: leave it, the caller is told the path changed.
  }
}

function refuseMove(message: string): IoResult<never> {
  return fail('io-error', message)
}

/** Moves a file or folder to a name that does not exist yet; a file with several hard links stays put. */
export async function moveEntry(source: ResolvedPath, destination: ResolvedPath): Promise<IoResult<null>> {
  if (!source.exists) return failFromErrno({ code: 'ENOENT' }, '')
  if (source.relative === '') return refuseMove('A root folder cannot be moved: move something inside it.')
  const entry = await lstatEntry(source)
  if (!entry.ok) return entry
  const kind = kindOf(entry.value)
  if (kind === 'other') return fail('special-file', 'That is not a regular file or folder (a pipe, socket or device) and was refused.')
  if (kind === 'directory' && isWithinOn(source.absolute, destination.absolute)) {
    return refuseMove('A folder cannot be moved into itself: choose a destination outside it.')
  }
  if (kind === 'file') {
    const linked = requireSingleLink(entry.value)
    if (linked !== null) return linked
  }
  const unfit = (await checkNewEntry(destination)) ?? (await parentUnchanged(source))
  if (unfit !== null) return unfit
  try {
    await rename(source.absolute, destination.absolute)
  } catch (error: unknown) {
    return failFromErrno(error, 'moving it')
  }
  return succeed(null)
}
