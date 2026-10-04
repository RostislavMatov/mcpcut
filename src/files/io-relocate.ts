import { link, lstat, rename, unlink } from 'node:fs/promises'
import { sameIdentity, statIdentity, type FileIdentity } from './identity.js'
import { changed, failFromErrno, succeed, type IoFailure, type IoResult } from './io-common.js'

/**
 * Moves one entry from `from` to `to` and checks that what arrived is what
 * was approved (security review H2d, LOW 1). Used by move, trash and restore.
 *
 *  - A FILE is moved with `link` then `unlink`: an entry created at `to` in
 *    the meantime fails with EEXIST instead of being overwritten (`rename`
 *    replaces silently). `link` takes whatever is at `from` now, so the
 *    destination is looked at afterwards: a different identity than the one
 *    recorded means `from` was swapped; the destination link is removed (the
 *    source was not touched, so this rollback is always safe) and the call is
 *    `changed`. If `from` is swapped again between `link` and `unlink`, the
 *    destination is kept (it holds the approved file) and the call is `changed`.
 *    A file system that cannot hard-link (FAT, some network shares) falls
 *    back to `rename`, with the same check afterwards.
 *  - A FOLDER keeps `rename` (it cannot be hard-linked). After it, `to` must
 *    carry the recorded identity; if not, the move is undone with a second
 *    `rename` only when nothing has appeared at `from` meanwhile, otherwise it
 *    is left as it is. Either way the call is `changed`.
 *
 * `before` runs immediately before the system call; a failure stops the move.
 */

export type RelocateKind = 'file' | 'directory'

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])

export async function relocate(
  from: string,
  to: string,
  kind: RelocateKind,
  expected: FileIdentity,
  before?: () => Promise<IoFailure | null>,
): Promise<IoResult<null>> {
  const unfit = (await before?.()) ?? null
  if (unfit !== null) return unfit
  return kind === 'file' ? relocateFile(from, to, expected) : relocateDirectory(from, to, expected)
}

async function relocateFile(from: string, to: string, expected: FileIdentity): Promise<IoResult<null>> {
  try {
    await link(from, to)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (!LINK_UNSUPPORTED.has(code)) return failFromErrno(error, 'moving it')
    return relocateDirectory(from, to, expected)
  }
  const placed = await statIdentity(to)
  if (placed === null || !sameIdentity(placed, expected)) {
    await removeIfStill(to, placed)
    return changed()
  }
  const source = await statIdentity(from)
  if (source === null || !sameIdentity(source, expected)) return changed()
  try {
    await unlink(from)
  } catch (error: unknown) {
    return failFromErrno(error, 'moving it')
  }
  return succeed(null)
}

/** Removes `file` only while it still is the link that was just made (`placed`). */
async function removeIfStill(file: string, placed: FileIdentity | null): Promise<void> {
  if (placed === null) return
  const now = await statIdentity(file)
  if (now !== null && sameIdentity(now, placed)) await unlink(file).catch(() => undefined)
}

async function relocateDirectory(from: string, to: string, expected: FileIdentity): Promise<IoResult<null>> {
  try {
    await rename(from, to)
  } catch (error: unknown) {
    return failFromErrno(error, 'moving it')
  }
  const placed = await statIdentity(to)
  if (placed !== null && sameIdentity(placed, expected)) return succeed(null)
  if (!(await isAbsent(from))) return changed()
  await rename(to, from).catch(() => undefined)
  return changed()
}

async function isAbsent(file: string): Promise<boolean> {
  return lstat(file).then(() => false, (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
}
