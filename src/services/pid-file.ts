import { open, rm, type FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { z } from 'zod'
import { MAX_TCP_PORT } from '../cli/serve-constants.js'
import { JOURNAL_FILE_MODE } from '../config.js'
import { errnoCodeOf } from '../errno.js'
import {
  PID_RECORD_VERSION,
  SERVICE_NAMES,
  SHARED_ACCESS_MASK,
  UNTRUSTED_PID_FILE_DETAIL,
} from './constants.js'

/**
 * The pid file of a managed service (mcpcut phase 1, Task 7): the only thing
 * connecting a `mcpcut start` to the detached process it left behind after
 * the terminal that ran it is gone.
 *
 * Three properties earn their own code here rather than a `writeFile` call:
 *
 *   - it is created EXCLUSIVELY (`open(path, 'wx')`, the same discipline as
 *     `journal/signing.ts`), so two `start` invocations racing on the same
 *     install cannot both believe they own the service — the loser is told
 *     `'exists'` and cleans up its own child instead of orphaning it. A write
 *     that fails after that create takes the file with it: a half-written pid
 *     file would read as `corrupt` for as long as nobody cleared it;
 *   - it is only trusted while only its owner can write it. Whoever can write
 *     this file chooses which pid a later `stop` signals, so the permissions
 *     are checked on the OPEN HANDLE (`fstat`, not a path `stat`, which a
 *     symlink swap between the two calls would defeat);
 *   - reading it never throws. A pid file left by a crashed process, a
 *     truncated write or an older schema is a normal thing for an operator
 *     to have on disk, so "absent", "ok" and "corrupt" are branches of the
 *     return type, and the manager decides what each means (a corrupt file
 *     becomes a `stale` status the operator can clear, never a stack trace).
 */

/**
 * The record itself. `strictObject` is a security property as much as a
 * hygiene one: nothing may smuggle an extra field (a token, a password) into
 * a file the manager writes on every start.
 */
export const pidRecordSchema = z.strictObject({
  version: z.literal(PID_RECORD_VERSION),
  service: z.enum(SERVICE_NAMES),
  // Positive on purpose: `process.kill(0, 0)` and `process.kill(-n, 0)` address
  // the whole process group, so a zero or negative pid must never reach the
  // liveness check or a stop.
  pid: z.number().int().positive(),
  host: z.string(),
  // Bounded, because the probe reads this: `net.connect` throws
  // `ERR_SOCKET_BAD_PORT` SYNCHRONOUSLY for a number outside the range, from
  // inside a function whose whole contract is that it never throws. `0` stays
  // legal — it is how "any free port" is spelled.
  port: z.number().int().min(0).max(MAX_TCP_PORT),
  startedAt: z.iso.datetime(),
})

/** One service's pid file contents. */
export type PidRecord = z.infer<typeof pidRecordSchema>

/** The honest outcome of looking for a pid file: no exceptions, three branches. */
export type PidFileRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly record: PidRecord }
  | { readonly kind: 'corrupt'; readonly detail: string }

/** Reads and validates a pid file. Never throws — see the module comment. */
export async function readPidFile(path: string): Promise<PidFileRead> {
  const bytes = await readPidFileBytes(path)
  if (bytes.kind !== 'read') return bytes

  const untrusted = untrustedOwnership(bytes.stats)
  if (untrusted !== undefined) return { kind: 'corrupt', detail: untrusted }

  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.raw)
  } catch (error: unknown) {
    return { kind: 'corrupt', detail: describeJsonFault(error) }
  }

  const result = pidRecordSchema.safeParse(parsed)
  if (!result.success) {
    return { kind: 'corrupt', detail: formatPidRecordErrors(result.error).join('; ') }
  }
  return { kind: 'ok', record: result.data }
}

/** The bytes plus the stat of the very handle they came from. */
type PidFileBytes =
  | { readonly kind: 'absent' }
  | { readonly kind: 'corrupt'; readonly detail: string }
  | { readonly kind: 'read'; readonly raw: string; readonly stats: Stats }

async function readPidFileBytes(path: string): Promise<PidFileBytes> {
  let handle: FileHandle
  try {
    handle = await open(path, 'r')
  } catch (error: unknown) {
    const code = errnoCodeOf(error)
    // A missing file and a missing `run/` directory both mean the same thing
    // to a caller: this service was never started from this data dir.
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' }
    return { kind: 'corrupt', detail: describeReadFailure(code, error) }
  }
  try {
    // `fstat` on the open handle, so the file whose mode is judged is exactly
    // the file whose bytes are read.
    const stats = await handle.stat()
    return { kind: 'read', raw: await handle.readFile('utf8'), stats }
  } catch (error: unknown) {
    return { kind: 'corrupt', detail: describeReadFailure(errnoCodeOf(error), error) }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Why this pid file may not be believed, or `undefined` when it may.
 *
 * Two questions: can anyone but the owner reach it, and does it belong to
 * this user at all. `process.getuid` is absent on Windows, where the manager
 * refuses to run anyway, so its absence skips the owner half rather than
 * inventing an answer.
 */
function untrustedOwnership(stats: Stats): string | undefined {
  if ((stats.mode & SHARED_ACCESS_MASK) !== 0) return UNTRUSTED_PID_FILE_DETAIL
  const uid = process.getuid?.()
  if (uid !== undefined && stats.uid !== uid) return UNTRUSTED_PID_FILE_DETAIL
  return undefined
}

/**
 * Creates the pid file, failing rather than overwriting when one is already
 * there. `'exists'` is a result, not an error: it is exactly what the loser
 * of a `start` race must see to back out cleanly.
 */
export async function createPidFileExclusive(
  path: string,
  record: PidRecord,
): Promise<'created' | 'exists'> {
  let handle: FileHandle
  try {
    handle = await open(path, 'wx', JOURNAL_FILE_MODE)
  } catch (error: unknown) {
    if (errnoCodeOf(error) === 'EEXIST') return 'exists'
    throw error
  }
  try {
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: 'utf8' })
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error: unknown) {
    // The create succeeded and the write did not: leaving the empty file
    // behind would make every later start read a `corrupt` pid file and
    // refuse. The file is ours — nothing else can have created it, since
    // `'wx'` only returns a handle when the path was free.
    await rm(path, { force: true })
    throw error
  }
  return 'created'
}

/** Removes a pid file; a file that is already gone is not an error. */
export async function removePidFile(path: string): Promise<void> {
  await rm(path, { force: true })
}

/** The `process.kill` shape the liveness check needs, injectable for tests. */
export type KillFn = (pid: number, signal?: number | string) => boolean

/**
 * Answers "is there still a process behind this pid" with POSIX's signal 0:
 * permission checks and existence checks run, nothing is delivered.
 *
 * `EPERM` counts as alive on purpose — the pid exists, it just belongs to
 * another user, and reporting it dead would let a `stop` conclude the file is
 * stale and clear it while a real process keeps the port.
 */
export function isProcessAlive(pid: number, kill: KillFn = process.kill): boolean {
  try {
    kill(pid, 0)
    return true
  } catch (error: unknown) {
    return errnoCodeOf(error) === 'EPERM'
  }
}

function describeReadFailure(code: string | undefined, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return code === undefined ? `cannot read: ${message}` : `${code}: ${message}`
}

/** Line/column of a `JSON.parse` failure, when V8's message carries one. */
const JSON_POSITION_PATTERN = /\(line (\d+) column (\d+)\)/

/**
 * V8 embeds a snippet of the offending input in most `SyntaxError` messages,
 * and this plane never echoes file contents into an error — the rule
 * `src/setup/load.ts` and `src/policy/store-backend.ts` already follow. A pid
 * file is a place a token could have been smuggled, so the position is the
 * only half repeated; a message without one degrades to the bare fact.
 */
function describeJsonFault(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const position = JSON_POSITION_PATTERN.exec(message)
  return position === null
    ? 'not valid JSON'
    : `not valid JSON (line ${position[1]} column ${position[2]})`
}

/**
 * One line per schema issue, in the shape of `policy/load.ts`'s
 * `formatPolicyErrors`: zod v4 reports a `strictObject`'s extra keys as one
 * `unrecognized_keys` issue carrying a `keys` array, so that case is expanded
 * into one line per key instead of a single vague line.
 */
function formatPidRecordErrors(error: z.ZodError): string[] {
  return error.issues.flatMap((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => `${path}: unknown key "${key}"`)
    }
    return [`${path}: ${issue.message}`]
  })
}
