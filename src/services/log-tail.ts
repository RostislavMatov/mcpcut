import { open, stat } from 'node:fs/promises'
import { errnoCodeOf } from '../errno.js'
import { LOG_TAIL_DEFAULT_LINES, LOG_TAIL_MAX_BYTES } from './constants.js'

/**
 * The tail of a service's daemon log (mcpcut phase 1, Task 9) — what `mcpcut
 * logs` prints, and what a failed `start` shows instead of "it did not come
 * up".
 *
 * Bounded by construction: log rotation is a later phase, so a `run/ui.log`
 * that has grown for months is a normal input. The tail therefore reads at
 * most `LOG_TAIL_MAX_BYTES` from the END of the file (`open` + positioned
 * `read`, never `readFile`), which costs the same on a 2 GiB log as on an
 * empty one.
 *
 * That window nearly always begins in the middle of a line. The first
 * fragment is dropped rather than printed, because a half line rendered as a
 * whole one misrepresents what the service logged — and the operator reading
 * a failed start has no other view of it.
 */
export async function readLogTail(
  path: string,
  lines: number = LOG_TAIL_DEFAULT_LINES,
): Promise<readonly string[]> {
  if (lines <= 0) return []

  const size = await logSize(path)
  if (size === undefined || size === 0) return []

  const length = Math.min(size, LOG_TAIL_MAX_BYTES)
  const window = await readWindowFromEnd(path, size - length, length)
  if (window === undefined) return []

  return lastLinesOf(window.toString('utf8'), lines, length < size)
}

/** Size of the log, or `undefined` when the service has no log yet. */
async function logSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch (error: unknown) {
    // A missing log is not a failure: it is what a never-started service
    // looks like, and the caller renders it as "no output yet".
    if (errnoCodeOf(error) === 'ENOENT') return undefined
    throw error
  }
}

/** Reads `length` bytes starting at `position`, or `undefined` if the log vanished meanwhile. */
async function readWindowFromEnd(
  path: string,
  position: number,
  length: number,
): Promise<Buffer | undefined> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error: unknown) {
    if (errnoCodeOf(error) === 'ENOENT') return undefined
    throw error
  }
  try {
    const buffer = Buffer.alloc(length)
    // A concurrent truncation (an operator clearing the log between the stat
    // and the read) shortens the answer rather than corrupting it.
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Splits a window into whole lines and keeps the last `lines` of them.
 *
 * `truncated` says the window began mid-file, in which case its first element
 * is the tail of a line whose head was never read.
 */
function lastLinesOf(text: string, lines: number, truncated: boolean): readonly string[] {
  const split = text.split('\n')
  // A newline-terminated log ends with an empty element that is not a line.
  if (split.at(-1) === '') split.pop()
  const whole = truncated ? split.slice(1) : split
  return whole.slice(-lines)
}
