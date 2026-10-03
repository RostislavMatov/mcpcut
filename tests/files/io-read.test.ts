import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { link, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { MAX_LIST_ENTRIES, MAX_READ_BYTES, TRASH_DIR_NAME } from '../../src/files/constants.js'
import { fileInfo, listDirectory, readText } from '../../src/files/io-read.js'
import { makeSandbox, problemOf, valueOf, type Sandbox } from './io-helpers.js'

/**
 * ADR-0020 §3.5-3.6: the read side of the I/O layer. A target was checked by
 * the resolver; here the path is verified AGAIN against the identity recorded
 * then, nothing special is ever opened, and what is returned is text.
 */

let sandbox: Sandbox

beforeAll(async () => {
  sandbox = await makeSandbox('read')
})

afterAll(async () => {
  await sandbox.cleanup()
})

describe('readText', () => {
  test('returns text, size, sha256 of the bytes and mtime', async () => {
    const file = join(sandbox.root, 'plain.txt')
    await writeFile(file, 'héllo\nworld')
    const value = valueOf(await readText(await sandbox.resolve('plain.txt')))
    expect(value.text).toBe('héllo\nworld')
    expect(value.size).toBe(Buffer.byteLength('héllo\nworld'))
    expect(value.sha256).toBe(createHash('sha256').update('héllo\nworld').digest('hex'))
    expect(new Date(value.mtime).toISOString()).toBe(value.mtime)
  })

  test('keeps a byte order mark in the text so an edit does not lose it', async () => {
    await writeFile(join(sandbox.root, 'bom.txt'), '﻿abc')
    expect(valueOf(await readText(await sandbox.resolve('bom.txt'))).text).toBe('﻿abc')
  })

  test('reads an empty file', async () => {
    await writeFile(join(sandbox.root, 'empty.txt'), '')
    expect(valueOf(await readText(await sandbox.resolve('empty.txt'))).text).toBe('')
  })

  test('reports not-found for a path that did not exist at resolve time', async () => {
    expect(problemOf(await readText(await sandbox.resolve('nope.txt')))).toBe('not-found')
  })

  test('reports not-found when the file vanished after resolve', async () => {
    const file = join(sandbox.root, 'gone.txt')
    await writeFile(file, 'x')
    const target = await sandbox.resolve('gone.txt')
    await rm(file)
    expect(problemOf(await readText(target))).toBe('not-found')
  })

  test('refuses a directory with not-a-file', async () => {
    await mkdir(join(sandbox.root, 'dir-a'), { recursive: true })
    expect(problemOf(await readText(await sandbox.resolve('dir-a')))).toBe('not-a-file')
  })

  test('refuses a symlink swapped in after resolve with changed and never reads its target', async () => {
    const file = join(sandbox.root, 'swap.txt')
    await writeFile(file, 'original')
    await writeFile(join(sandbox.root, 'other.txt'), 'SECRET')
    const target = await sandbox.resolve('swap.txt')
    await rm(file)
    await symlink(join(sandbox.root, 'other.txt'), file)
    const result = await readText(target)
    expect(problemOf(result)).toBe('changed')
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  test('refuses a file replaced by another file after resolve with changed', async () => {
    const file = join(sandbox.root, 'replaced.txt')
    await writeFile(file, 'one')
    const target = await sandbox.resolve('replaced.txt')
    await writeFile(join(sandbox.root, 'replacement.tmp'), 'two')
    const { rename } = await import('node:fs/promises')
    await rename(join(sandbox.root, 'replacement.tmp'), file)
    expect(problemOf(await readText(target))).toBe('changed')
  })

  test('allows reading a file with several hard links', async () => {
    await writeFile(join(sandbox.root, 'h1.txt'), 'shared')
    await link(join(sandbox.root, 'h1.txt'), join(sandbox.root, 'h2.txt'))
    expect(valueOf(await readText(await sandbox.resolve('h2.txt'))).text).toBe('shared')
  })

  test('refuses binary content (NUL in the first 8 KiB)', async () => {
    await writeFile(join(sandbox.root, 'bin.dat'), Buffer.from([0x68, 0x00, 0x69]))
    expect(problemOf(await readText(await sandbox.resolve('bin.dat')))).toBe('binary')
  })

  test('refuses invalid UTF-8 as binary', async () => {
    await writeFile(join(sandbox.root, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    expect(problemOf(await readText(await sandbox.resolve('latin.txt')))).toBe('binary')
  })

  test('refuses a file over the read limit with too-large', async () => {
    const file = join(sandbox.root, 'huge.txt')
    await writeFile(file, '')
    await truncate(file, MAX_READ_BYTES + 1)
    expect(problemOf(await readText(await sandbox.resolve('huge.txt')))).toBe('too-large')
  })

  test.skipIf(process.platform === 'win32')('refuses a FIFO with special-file and does not block', async () => {
    execFileSync('mkfifo', [join(sandbox.root, 'pipe.fifo')])
    const result = await readText(await sandbox.resolve('pipe.fifo'))
    expect(problemOf(result)).toBe('special-file')
  }, 5000)

  test.skipIf(process.platform === 'win32')('refuses a FIFO swapped in after resolve without blocking', async () => {
    const file = join(sandbox.root, 'later.fifo')
    await writeFile(file, 'x')
    const target = await sandbox.resolve('later.fifo')
    await rm(file)
    execFileSync('mkfifo', [file])
    expect(['special-file', 'changed']).toContain(problemOf(await readText(target)))
  }, 5000)

  test('messages are one line and do not echo the absolute path', async () => {
    const result = await readText(await sandbox.resolve('nope-either.txt'))
    if (result.ok) throw new Error('expected failure')
    expect(result.message).not.toContain('\n')
    expect(result.message).not.toContain(sandbox.base)
  })
})

describe('listDirectory', () => {
  test('lists sorted entries with kinds, sizes only for files, and hides the trash', async () => {
    const folder = join(sandbox.root, 'ls')
    await mkdir(join(folder, 'sub'), { recursive: true })
    await mkdir(join(folder, TRASH_DIR_NAME), { recursive: true })
    await writeFile(join(folder, 'b.txt'), 'bb')
    await writeFile(join(folder, 'a.txt'), 'a')
    await symlink(join(folder, 'a.txt'), join(folder, 'link'))
    const value = valueOf(await listDirectory(await sandbox.resolve('ls')))
    expect(value.entries).toEqual([
      { name: 'a.txt', kind: 'file', size: 1 },
      { name: 'b.txt', kind: 'file', size: 2 },
      { name: 'link', kind: 'symlink' },
      { name: 'sub', kind: 'directory' },
    ])
    expect(value.truncated).toBe(false)
  })

  test('does not list the root trash folder', async () => {
    const value = valueOf(await listDirectory(await sandbox.resolve()))
    expect(value.entries.map((entry) => entry.name)).not.toContain(TRASH_DIR_NAME)
  })

  test('caps the list at the maximum and says so', async () => {
    const folder = join(sandbox.root, 'many')
    await mkdir(folder)
    await Promise.all(Array.from({ length: MAX_LIST_ENTRIES + 5 }, (_, i) => writeFile(join(folder, `f${String(i).padStart(5, '0')}`), '')))
    const value = valueOf(await listDirectory(await sandbox.resolve('many')))
    expect(value.entries).toHaveLength(MAX_LIST_ENTRIES)
    expect(value.truncated).toBe(true)
    expect(value.entries[0]?.name).toBe('f00000')
  })

  test('refuses a file with not-a-directory', async () => {
    await writeFile(join(sandbox.root, 'afile'), 'x')
    expect(problemOf(await listDirectory(await sandbox.resolve('afile')))).toBe('not-a-directory')
  })

  test('refuses a folder swapped for a symlink after resolve with changed', async () => {
    await mkdir(join(sandbox.root, 'sw'))
    await mkdir(join(sandbox.root, 'elsewhere'))
    const target = await sandbox.resolve('sw')
    await rm(join(sandbox.root, 'sw'), { recursive: true })
    await symlink(join(sandbox.root, 'elsewhere'), join(sandbox.root, 'sw'))
    expect(problemOf(await listDirectory(target))).toBe('changed')
  })

  test('reports not-found for a missing folder', async () => {
    expect(problemOf(await listDirectory(await sandbox.resolve('missing-folder')))).toBe('not-found')
  })
})

describe('fileInfo', () => {
  test('describes a file and a folder', async () => {
    await writeFile(join(sandbox.root, 'info.txt'), 'abc')
    await link(join(sandbox.root, 'info.txt'), join(sandbox.root, 'info2.txt'))
    const file = valueOf(await fileInfo(await sandbox.resolve('info.txt')))
    expect(file).toMatchObject({ kind: 'file', size: 3, nlink: 2 })
    const folder = valueOf(await fileInfo(await sandbox.resolve('ls')))
    expect(folder.kind).toBe('directory')
  })

  test('reports not-found and changed', async () => {
    expect(problemOf(await fileInfo(await sandbox.resolve('no-info')))).toBe('not-found')
    await writeFile(join(sandbox.root, 'sw-info'), 'x')
    const target = await sandbox.resolve('sw-info')
    await rm(join(sandbox.root, 'sw-info'))
    await symlink(join(sandbox.root, 'info.txt'), join(sandbox.root, 'sw-info'))
    expect(problemOf(await fileInfo(target))).toBe('changed')
  })
})
