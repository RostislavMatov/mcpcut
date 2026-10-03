import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { resolveWithinRoots, type ResolvedPath } from '../../src/files/paths.js'

/** Failure paths that need a failing `rename`: the temp file must not be left behind. */

const renameFailure = vi.hoisted(() => ({ code: '' }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    rename: async (from: string, to: string) => {
      if (renameFailure.code !== '') throw Object.assign(new Error('injected'), { code: renameFailure.code })
      return original.rename(from, to)
    },
  }
})

const { replaceFile, moveEntry } = await import('../../src/files/io-write.js')

let base: string
let root: string

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-io-fail-')))
  root = join(base, 'r')
  await (await import('node:fs/promises')).mkdir(root)
})

afterAll(async () => {
  renameFailure.code = ''
  await rm(base, { recursive: true, force: true })
})

async function target(name: string): Promise<ResolvedPath> {
  const result = await resolveWithinRoots(join(root, name), [root])
  if (!result.ok) throw new Error(result.message)
  return result.path
}

describe('failing rename', () => {
  test('replaceFile removes its temp file and keeps the old content', async () => {
    await writeFile(join(root, 'a.txt'), 'old')
    const resolved = await target('a.txt')
    renameFailure.code = 'EIO'
    const result = await replaceFile(resolved, 'new')
    renameFailure.code = ''
    expect(result).toMatchObject({ ok: false, problem: 'io-error' })
    expect(await readdir(root)).toEqual(['a.txt'])
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old')
  })

  test('moveEntry maps EXDEV to cross-device and says to copy and delete', async () => {
    await writeFile(join(root, 'b.txt'), 'b')
    const source = await target('b.txt')
    const destination = await target('c.txt')
    renameFailure.code = 'EXDEV'
    const result = await moveEntry(source, destination)
    renameFailure.code = ''
    expect(result).toMatchObject({ ok: false, problem: 'cross-device' })
    if (!result.ok) expect(result.message).toContain('copy and delete')
  })
})
