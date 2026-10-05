import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { open } from 'node:fs/promises'
import { O_NOFOLLOW, O_NONBLOCK } from '../io-common.js'

/**
 * The sha256 of one file for the catalog, read through a handle opened
 * without following a symlink and checked against the `lstat` the walk took:
 * a file swapped for another thing in between is skipped, not hashed.
 * `null` means "no hash" (not an error): the row is kept without one.
 */

export type HashFile = (file: string, lstat: BigIntStats) => Promise<string | null>

export const hashCatalogFile: HashFile = async (file, lstat) => {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.ino !== lstat.ino || opened.dev !== lstat.dev) return null
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer)
    return hash.digest('hex')
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}
