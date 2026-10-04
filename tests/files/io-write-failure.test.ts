import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { resolveWithinRoots, type ResolvedPath } from '../../src/files/paths.js'

/** Failure paths that need a failing `rename` or `link`: the temp file must not be left behind, a file move maps EXDEV. */

const renameFailure = vi.hoisted(() => ({ code: '' }))
const linkFailure = vi.hoisted(() => ({ code: '' }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    link: async (from: string, to: string) => {
      if (linkFailure.code !== '') throw Object.assign(new Error('injected'), { code: linkFailure.code })
      return original.link(from, to)
    },
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
  await mkdir(root)
})

afterAll(async () => {
  renameFailure.code = ''
  linkFailure.code = ''
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

  test('moveEntry of a file maps a link EXDEV to cross-device and says to copy and delete', async () => {
    await writeFile(join(root, 'b.txt'), 'b')
    const source = await target('b.txt')
    const destination = await target('c.txt')
    linkFailure.code = 'EXDEV'
    const result = await moveEntry(source, destination)
    linkFailure.code = ''
    expect(result).toMatchObject({ ok: false, problem: 'cross-device' })
    if (!result.ok) expect(result.message).toContain('copy and delete')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('b')
  })

  test('moveEntry of a folder maps a rename EXDEV to cross-device', async () => {
    await mkdir(join(root, 'dir'))
    const source = await target('dir')
    const destination = await target('dir2')
    renameFailure.code = 'EXDEV'
    const result = await moveEntry(source, destination)
    renameFailure.code = ''
    expect(result).toMatchObject({ ok: false, problem: 'cross-device' })
  })

  test('a file system that cannot hard-link falls back to rename and still moves the file', async () => {
    await writeFile(join(root, 'f.txt'), 'f')
    const source = await target('f.txt')
    const destination = await target('g.txt')
    linkFailure.code = 'EPERM'
    const result = await moveEntry(source, destination)
    linkFailure.code = ''
    expect(result).toMatchObject({ ok: true })
    expect(await readFile(join(root, 'g.txt'), 'utf8')).toBe('f')
  })
})
