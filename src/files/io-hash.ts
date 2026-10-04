import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { MAX_READ_BYTES } from './constants.js'
import { O_NOFOLLOW, O_NONBLOCK, sha256Of } from './io-common.js'

/**
 * The sha256 of a regular file at `file` within the read limit (opened
 * without following a symlink); `undefined` for anything else or on a read
 * error. The trash records it after the rename and checks it before a restore.
 */
export async function hashRegularFile(file: string): Promise<string | undefined> {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return undefined
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > MAX_READ_BYTES) return undefined
    return sha256Of(await handle.readFile())
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}
