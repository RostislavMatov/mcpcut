import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWithinRoots, type ResolvedPath } from '../../src/files/paths.js'
import { TRASH_DIR_NAME } from '../../src/files/constants.js'
import type { IoResult } from '../../src/files/io-common.js'

/** A scratch root with its trash folder, never the real ~/.mcpcut. */
export interface Sandbox {
  readonly base: string
  readonly root: string
  readonly trash: string
  resolve(...segments: string[]): Promise<ResolvedPath>
  cleanup(): Promise<void>
}

export async function makeSandbox(prefix: string): Promise<Sandbox> {
  const base = await realpath(await mkdtemp(join(tmpdir(), `mcpcut-io-${prefix}-`)))
  const root = join(base, 'r')
  const trash = join(root, TRASH_DIR_NAME)
  await mkdir(trash, { recursive: true, mode: 0o700 })
  return {
    base,
    root,
    trash,
    async resolve(...segments: string[]): Promise<ResolvedPath> {
      const result = await resolveWithinRoots(join(root, ...segments), [root])
      if (!result.ok) throw new Error(`${result.refusal}: ${result.message}`)
      return result.path
    },
    async cleanup(): Promise<void> {
      await rm(base, { recursive: true, force: true })
    },
  }
}

/** The value of a successful result; throws with the message otherwise. */
export function valueOf<T>(result: IoResult<T>): T {
  if (!result.ok) throw new Error(`${result.problem}: ${result.message}`)
  return result.value
}

/** The problem of a failed result; throws if it succeeded. */
export function problemOf<T>(result: IoResult<T>): string {
  if (result.ok) throw new Error('expected a failure')
  return result.problem
}

export async function namesIn(folder: string): Promise<string[]> {
  return (await readdir(folder)).sort()
}
