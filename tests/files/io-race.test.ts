import { lstat, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { sha256Of } from '../../src/files/io-common.js'
import { relocate } from '../../src/files/io-relocate.js'
import { moveToTrash } from '../../src/files/io-trash.js'
import { restoreFromTrash } from '../../src/files/io-trash-admin.js'
import { moveEntry, writeNewFile } from '../../src/files/io-write.js'
import { statIdentity } from '../../src/files/identity.js'
import { makeSandbox, namesIn, problemOf, valueOf, type Sandbox } from './io-helpers.js'

/**
 * Security review H2 and its LOW follow-ups: every create and rename is
 * preceded by a fresh identity check (the `beforeCommit` hook runs just
 * before it, where a racing attacker would act), what was created or moved
 * is verified afterwards, a file move never overwrites (`link` + `unlink`),
 * and the trash hashes the stored copy.
 */

let sandbox: Sandbox
let outside: string

beforeEach(async () => {
  sandbox = await makeSandbox('race')
  outside = join(sandbox.base, 'outside')
  await mkdir(outside)
})
afterEach(async () => {
  await sandbox.cleanup()
})

const at = (...segments: string[]): string => join(sandbox.root, ...segments)

describe('writeNewFile', () => {
  test('a parent swapped for a symlink just before the create writes nothing outside', async () => {
    await mkdir(at('sub'))
    const target = await sandbox.resolve('sub', 'f.txt')
    const result = await writeNewFile(target, 'secret', {
      beforeCommit: async () => {
        await rename(at('sub'), at('sub-old'))
        await symlink(outside, at('sub'))
      },
    })
    expect(problemOf(result)).toBe('changed')
    expect(await namesIn(outside)).toEqual([])
  })

  test('a file swapped for another right after the create is reported changed and the stranger is left alone', async () => {
    const target = await sandbox.resolve('f.txt')
    const result = await writeNewFile(target, 'mine', {
      afterCommit: async () => {
        await writeFile(at('other'), 'theirs')
        await rename(at('other'), at('f.txt'))
      },
    })
    expect(problemOf(result)).toBe('changed')
    expect(await readFile(at('f.txt'), 'utf8')).toBe('theirs')
  })

  test('the created file lies inside the root and is returned as before', async () => {
    const info = valueOf(await writeNewFile(await sandbox.resolve('ok.txt'), 'hello'))
    expect(info.sha256).toBe(sha256Of('hello'))
    expect(await readFile(at('ok.txt'), 'utf8')).toBe('hello')
  })

  test('a folder swapped away right after the create leaves nothing of ours behind', async () => {
    await mkdir(at('sub'))
    const target = await sandbox.resolve('sub', 'f.txt')
    const result = await writeNewFile(target, 'x', {
      afterCommit: async () => {
        await rename(at('sub'), at('sub-old'))
        await symlink(outside, at('sub'))
      },
    })
    expect(problemOf(result)).toBe('changed')
    expect(await namesIn(outside)).toEqual([])
  })
})

describe('moveEntry', () => {
  test('a source replaced just before the move is refused and stays', async () => {
    await writeFile(at('a.txt'), 'A')
    const source = await sandbox.resolve('a.txt')
    const result = await moveEntry(source, await sandbox.resolve('b.txt'), {
      beforeCommit: async () => {
        await writeFile(at('swap'), 'S')
        await rename(at('swap'), at('a.txt'))
      },
    })
    expect(problemOf(result)).toBe('changed')
    expect(await readFile(at('a.txt'), 'utf8')).toBe('S')
    expect(await namesIn(sandbox.root)).not.toContain('b.txt')
  })

  test('a file created at the destination meanwhile is not overwritten', async () => {
    await writeFile(at('a.txt'), 'A')
    const result = await moveEntry(await sandbox.resolve('a.txt'), await sandbox.resolve('b.txt'), {
      beforeCommit: async () => {
        await writeFile(at('b.txt'), 'theirs')
      },
    })
    expect(problemOf(result)).toBe('exists')
    expect(await readFile(at('b.txt'), 'utf8')).toBe('theirs')
    expect(await readFile(at('a.txt'), 'utf8')).toBe('A')
  })

  test('a file moves with its content and no copy stays behind', async () => {
    await writeFile(at('a.txt'), 'A')
    valueOf(await moveEntry(await sandbox.resolve('a.txt'), await sandbox.resolve('b.txt')))
    expect(await readFile(at('b.txt'), 'utf8')).toBe('A')
    expect(await namesIn(sandbox.root)).not.toContain('a.txt')
    expect((await lstat(at('b.txt'))).nlink).toBe(1)
  })
})

describe('relocate', () => {
  test('a file that is not the expected identity is taken back: the destination link goes, the source stays', async () => {
    await writeFile(at('a.txt'), 'A')
    await writeFile(at('wrong'), 'W')
    const expected = await statIdentity(at('wrong'))
    const result = await relocate(at('a.txt'), at('b.txt'), 'file', expected ?? { dev: 0n, ino: 0n })
    expect(problemOf(result)).toBe('changed')
    expect(await readFile(at('a.txt'), 'utf8')).toBe('A')
    expect(await namesIn(sandbox.root)).not.toContain('b.txt')
  })

  test('a folder that is not the expected identity is renamed back when its old place is free', async () => {
    await mkdir(at('d'))
    await writeFile(at('d', 'in.txt'), 'x')
    await mkdir(at('wrong'))
    const expected = await statIdentity(at('wrong'))
    const result = await relocate(at('d'), at('e'), 'directory', expected ?? { dev: 0n, ino: 0n })
    expect(problemOf(result)).toBe('changed')
    expect(await readFile(at('d', 'in.txt'), 'utf8')).toBe('x')
    expect(await namesIn(sandbox.root)).not.toContain('e')
  })

  test('a file move onto an existing name is refused as exists and nothing changes', async () => {
    await writeFile(at('a.txt'), 'A')
    await writeFile(at('b.txt'), 'B')
    const expected = await statIdentity(at('a.txt'))
    const result = await relocate(at('a.txt'), at('b.txt'), 'file', expected ?? { dev: 0n, ino: 0n })
    expect(problemOf(result)).toBe('exists')
    expect(await readFile(at('b.txt'), 'utf8')).toBe('B')
  })

  test('hard links stay a hard-link count of one after the move', async () => {
    await writeFile(at('a.txt'), 'A')
    const expected = await statIdentity(at('a.txt'))
    valueOf(await relocate(at('a.txt'), at('c.txt'), 'file', expected ?? { dev: 0n, ino: 0n }))
    expect((await lstat(at('c.txt'))).nlink).toBe(1)
  })
})

describe('moveToTrash', () => {
  test('hashes the stored copy after the rename, not the file before it', async () => {
    await writeFile(at('t.txt'), 'before')
    const target = await sandbox.resolve('t.txt')
    const manifest = valueOf(
      await moveToTrash(target, 'me', {
        beforeCommit: async () => {
          await writeFile(at('t.txt'), 'after-change')
        },
      }),
    )
    expect(manifest.sha256).toBe(sha256Of('after-change'))
    expect(manifest.size).toBe('after-change'.length)
  })

  test('a file swapped just before the rename is refused, stays, and no trash entry is left', async () => {
    await writeFile(at('t.txt'), 'orig')
    const target = await sandbox.resolve('t.txt')
    const result = await moveToTrash(target, 'me', {
      beforeCommit: async () => {
        await writeFile(at('swap'), 'S')
        await rename(at('swap'), at('t.txt'))
      },
    })
    expect(problemOf(result)).toBe('changed')
    expect(await readFile(at('t.txt'), 'utf8')).toBe('S')
    expect(await namesIn(sandbox.trash)).toEqual([])
  })

  test('a parent swapped just before the rename is refused', async () => {
    await mkdir(at('sub'))
    await writeFile(at('sub', 't.txt'), 'x')
    const target = await sandbox.resolve('sub', 't.txt')
    const result = await moveToTrash(target, 'me', {
      beforeCommit: async () => {
        await rename(at('sub'), at('sub-old'))
        await symlink(outside, at('sub'))
      },
    })
    expect(problemOf(result)).toBe('changed')
    expect(await namesIn(sandbox.trash)).toEqual([])
  })
})

describe('restoreFromTrash', () => {
  test('refuses a payload whose content no longer matches the manifest and keeps it', async () => {
    await writeFile(at('r.txt'), 'original')
    const manifest = valueOf(await moveToTrash(await sandbox.resolve('r.txt'), 'me'))
    await writeFile(join(sandbox.trash, manifest.id, 'r.txt'), 'tampered')
    const result = await restoreFromTrash(sandbox.root, manifest.id)
    expect(problemOf(result)).toBe('changed')
    if (!result.ok) {
      expect(result.message).toContain('differs from the manifest')
      expect(result.message).not.toContain('\n')
    }
    expect(await namesIn(sandbox.root)).not.toContain('r.txt')
    expect(await readFile(join(sandbox.trash, manifest.id, 'r.txt'), 'utf8')).toBe('tampered')
  })

  test('a file created at the original path meanwhile is not overwritten', async () => {
    await writeFile(at('r.txt'), 'original')
    const manifest = valueOf(await moveToTrash(await sandbox.resolve('r.txt'), 'me'))
    const result = await restoreFromTrash(sandbox.root, manifest.id, {
      beforeCommit: async () => {
        await writeFile(at('r.txt'), 'newcomer')
      },
    })
    expect(problemOf(result)).toBe('exists')
    expect(await readFile(at('r.txt'), 'utf8')).toBe('newcomer')
    expect(await namesIn(sandbox.trash)).toContain(manifest.id)
  })

  test('restores an untouched file and a folder', async () => {
    await writeFile(at('r.txt'), 'original')
    await mkdir(at('d'))
    const file = valueOf(await moveToTrash(await sandbox.resolve('r.txt'), 'me'))
    const folder = valueOf(await moveToTrash(await sandbox.resolve('d'), 'me'))
    valueOf(await restoreFromTrash(sandbox.root, file.id))
    valueOf(await restoreFromTrash(sandbox.root, folder.id))
    expect(await readFile(at('r.txt'), 'utf8')).toBe('original')
    expect((await lstat(at('d'))).isDirectory()).toBe(true)
  })
})
