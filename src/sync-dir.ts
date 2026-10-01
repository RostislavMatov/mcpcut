import { open } from 'node:fs/promises'
import { errnoCodeOf } from './errno.js'

/**
 * Codes a platform answers when it will not fsync (or open) a directory.
 * EACCES and EBADF are among them as the vault always had it: an output
 * directory that truly cannot be read fails on the files written into it
 * first, so tolerating them here hides no lost write.
 */
const DIR_SYNC_UNSUPPORTED_CODES: readonly string[] = ['EPERM', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EACCES', 'EBADF']

/** The slice of a directory handle `syncDir` uses; a seam for the refusals above. */
export interface DirHandle {
  sync(): Promise<void>
  close(): Promise<void>
}

export type DirOpener = (path: string) => Promise<DirHandle>

const openForSync: DirOpener = (path) => open(path, 'r')

function isUnsupported(error: unknown): boolean {
  const code = errnoCodeOf(error)
  return code !== undefined && DIR_SYNC_UNSUPPORTED_CODES.includes(code)
}

/**
 * Flushes a directory's entries, so files just created or renamed into it
 * survive a power loss as their contents already do. Some platforms and
 * filesystems refuse to fsync a directory at all — Windows answers EPERM —
 * and that is a platform limitation, not a failure of the write it follows:
 * those codes are tolerated, anything else (a missing directory, an I/O
 * error) propagates. Shared by the vault and
 * `export --report` (the smoke of 0.2.4 on Windows found the report's own
 * copy, which tolerated nothing, failing every export there).
 */
export async function syncDir(path: string, openDir: DirOpener = openForSync): Promise<void> {
  let handle: DirHandle
  try {
    handle = await openDir(path)
  } catch (error: unknown) {
    if (isUnsupported(error)) return
    throw error
  }
  try {
    await handle.sync()
  } catch (error: unknown) {
    if (!isUnsupported(error)) throw error
  } finally {
    await handle.close()
  }
}
