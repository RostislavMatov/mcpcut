import { link, lstat, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { makeDirectory, moveEntry } from '../../src/files/io-write.js'
import { makeSandbox, namesIn, problemOf, valueOf, type Sandbox } from './io-helpers.js'

/** ADR-0020 §3: creating a folder and moving an entry keep the same identity rules as files. */

let sandbox: Sandbox

beforeAll(async () => {
  sandbox = await makeSandbox('move')
})

afterAll(async () => {
  await sandbox.cleanup()
})

describe('makeDirectory', () => {
  test('creates a folder with mode 755 (before umask)', async () => {
    valueOf(await makeDirectory(await sandbox.resolve('newdir')))
    const stats = await stat(join(sandbox.root, 'newdir'))
    expect(stats.isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect(stats.mode & 0o700).toBe(0o700)
  })

  test('refuses an existing path, including one created after resolve', async () => {
    await mkdir(join(sandbox.root, 'have'))
    expect(problemOf(await makeDirectory(await sandbox.resolve('have')))).toBe('exists')
    const target = await sandbox.resolve('late')
    await mkdir(join(sandbox.root, 'late'))
    expect(problemOf(await makeDirectory(target))).toBe('exists')
  })

  test('refuses a missing parent (not recursive) and says to create it first', async () => {
    const result = await makeDirectory(await sandbox.resolve('a', 'b'))
    expect(problemOf(result)).toBe('parent-missing')
    await expect(lstat(join(sandbox.root, 'a'))).rejects.toThrow()
  })

  test('refuses a parent swapped for a symlink after resolve', async () => {
    await mkdir(join(sandbox.root, 'mp'))
    await mkdir(join(sandbox.root, 'out'))
    const target = await sandbox.resolve('mp', 'x')
    await rename(join(sandbox.root, 'mp'), join(sandbox.root, 'mp-old'))
    await symlink(join(sandbox.root, 'out'), join(sandbox.root, 'mp'))
    expect(problemOf(await makeDirectory(target))).toBe('changed')
    expect(await namesIn(join(sandbox.root, 'out'))).toEqual([])
  })
})

describe('moveEntry', () => {
  test('moves a file', async () => {
    await writeFile(join(sandbox.root, 'm1.txt'), 'data')
    valueOf(await moveEntry(await sandbox.resolve('m1.txt'), await sandbox.resolve('m1-moved.txt')))
    expect(await readFile(join(sandbox.root, 'm1-moved.txt'), 'utf8')).toBe('data')
    await expect(lstat(join(sandbox.root, 'm1.txt'))).rejects.toThrow()
  })

  test('moves a folder with its content', async () => {
    await mkdir(join(sandbox.root, 'f1'))
    await writeFile(join(sandbox.root, 'f1', 'x.txt'), 'x')
    await mkdir(join(sandbox.root, 'dest'))
    valueOf(await moveEntry(await sandbox.resolve('f1'), await sandbox.resolve('dest', 'f1')))
    expect(await readFile(join(sandbox.root, 'dest', 'f1', 'x.txt'), 'utf8')).toBe('x')
  })

  test('refuses an existing destination and keeps both', async () => {
    await writeFile(join(sandbox.root, 's.txt'), 's')
    await writeFile(join(sandbox.root, 'd.txt'), 'd')
    const result = await moveEntry(await sandbox.resolve('s.txt'), await sandbox.resolve('d.txt'))
    expect(problemOf(result)).toBe('exists')
    expect(await readFile(join(sandbox.root, 'd.txt'), 'utf8')).toBe('d')
  })

  test('refuses a missing source and a missing destination parent', async () => {
    expect(problemOf(await moveEntry(await sandbox.resolve('ghost'), await sandbox.resolve('ghost2')))).toBe('not-found')
    await writeFile(join(sandbox.root, 'pm.txt'), 'x')
    const result = await moveEntry(await sandbox.resolve('pm.txt'), await sandbox.resolve('nofolder', 'pm.txt'))
    expect(problemOf(result)).toBe('parent-missing')
  })

  test('refuses moving a folder into itself or into its own subfolder', async () => {
    await mkdir(join(sandbox.root, 'self', 'sub'), { recursive: true })
    const source = await sandbox.resolve('self')
    expect(problemOf(await moveEntry(source, await sandbox.resolve('self', 'inner')))).toBe('io-error')
    expect(problemOf(await moveEntry(source, await sandbox.resolve('self', 'sub', 'inner')))).toBe('io-error')
    expect(await namesIn(join(sandbox.root, 'self'))).toEqual(['sub'])
  })

  test('allows a sibling whose name only starts like the source (no prefix confusion)', async () => {
    await mkdir(join(sandbox.root, 'pre'))
    valueOf(await moveEntry(await sandbox.resolve('pre'), await sandbox.resolve('pre-fix')))
  })

  test('refuses to move a root', async () => {
    expect(problemOf(await moveEntry(await sandbox.resolve(), await sandbox.resolve('rootmoved')))).toBe('io-error')
  })

  test('refuses a hard-linked file', async () => {
    await writeFile(join(sandbox.root, 'hm1.txt'), 'x')
    await link(join(sandbox.root, 'hm1.txt'), join(sandbox.root, 'hm2.txt'))
    expect(problemOf(await moveEntry(await sandbox.resolve('hm1.txt'), await sandbox.resolve('hm3.txt')))).toBe('hard-linked')
  })

  test('refuses a source swapped for a symlink after resolve', async () => {
    await writeFile(join(sandbox.root, 'ms.txt'), 'x')
    await writeFile(join(sandbox.root, 'ms-victim.txt'), 'victim')
    const source = await sandbox.resolve('ms.txt')
    const destination = await sandbox.resolve('ms-dest.txt')
    await rm(join(sandbox.root, 'ms.txt'))
    await symlink(join(sandbox.root, 'ms-victim.txt'), join(sandbox.root, 'ms.txt'))
    expect(problemOf(await moveEntry(source, destination))).toBe('changed')
    await expect(lstat(join(sandbox.root, 'ms-dest.txt'))).rejects.toThrow()
  })
})
