import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { O_NOFOLLOW, O_NONBLOCK } from '../io-common.js'

/**
 * The sha256 of one file for the catalog, read through a handle opened
 * without following a symlink and checked against the `lstat` the walk took:
 * a file swapped for another thing in between is skipped, not hashed.
 * `null` means "no hash" (not an error): the row is kept without one.
 */

/**
 * Whether an opened file is the one its path names with no symlink on the
 * way: the parent folder is its own canonical path (roots are stored
 * canonical) and the handle is the file `lstat` sees there now. `O_NOFOLLOW`
 * guards only the last name; a folder swapped for a symlink to a private
 * folder, opened through and swapped back, fails one of the two.
 */
export async function isOpenedDirectly(file: string, opened: { readonly dev: bigint; readonly ino: bigint }): Promise<boolean> {
  try {
    const parent = path.dirname(file)
    if ((await realpath(parent)) !== parent) return false
    const now = await lstat(file, { bigint: true })
    return now.isFile() && now.dev === opened.dev && now.ino === opened.ino
  } catch {
    return false
  }
}

export type HashFile = (file: string, lstat: BigIntStats) => Promise<string | null>

export const hashCatalogFile: HashFile = async (file, walked) => {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.ino !== walked.ino || opened.dev !== walked.dev) return null
    if (!(await isOpenedDirectly(file, opened))) return null
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer)
    return hash.digest('hex')
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}
