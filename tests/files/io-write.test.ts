import { execFileSync } from 'node:child_process'
import { chmod, link, lstat, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { MAX_WRITE_BYTES } from '../../src/files/constants.js'
import { readText } from '../../src/files/io-read.js'
import { editFile, replaceFile, writeNewFile } from '../../src/files/io-write.js'
import { makeSandbox, namesIn, problemOf, valueOf, type Sandbox } from './io-helpers.js'

/**
 * ADR-0020 §3.5-3.6: creating takes O_EXCL, changing goes through a temp file
 * beside the target and `rename` — which replaces a swapped-in symlink instead
 * of following it — and a hard-linked file is never changed.
 */

let sandbox: Sandbox

beforeAll(async () => {
  sandbox = await makeSandbox('write')
})

afterAll(async () => {
  await sandbox.cleanup()
})

async function swapForSymlink(file: string, to: string): Promise<void> {
  await rm(file)
  await symlink(to, file)
}

describe('writeNewFile', () => {
  test('creates the file with the content and fsyncs it', async () => {
    const result = valueOf(await writeNewFile(await sandbox.resolve('new.txt'), 'héllo'))
    expect(await readFile(join(sandbox.root, 'new.txt'), 'utf8')).toBe('héllo')
    expect(result.size).toBe(Buffer.byteLength('héllo'))
    expect(result.sha256).toHaveLength(64)
  })

  test('refuses a path that already existed at resolve time', async () => {
    await writeFile(join(sandbox.root, 'there.txt'), 'old')
    expect(problemOf(await writeNewFile(await sandbox.resolve('there.txt'), 'new'))).toBe('exists')
    expect(await readFile(join(sandbox.root, 'there.txt'), 'utf8')).toBe('old')
  })

  test('refuses a path created after resolve (O_EXCL) and keeps the other content', async () => {
    const target = await sandbox.resolve('race.txt')
    await writeFile(join(sandbox.root, 'race.txt'), 'theirs')
    expect(problemOf(await writeNewFile(target, 'mine'))).toBe('exists')
    expect(await readFile(join(sandbox.root, 'race.txt'), 'utf8')).toBe('theirs')
  })

  test('does not follow a dangling symlink planted after resolve', async () => {
    const target = await sandbox.resolve('planted.txt')
    await symlink(join(sandbox.root, 'victim.txt'), join(sandbox.root, 'planted.txt'))
    expect(problemOf(await writeNewFile(target, 'x'))).toBe('exists')
    await expect(lstat(join(sandbox.root, 'victim.txt'))).rejects.toThrow()
  })

  test('refuses a missing parent folder and says to create it first', async () => {
    const result = await writeNewFile(await sandbox.resolve('nofolder', 'deep', 'x.txt'), 'x')
    expect(problemOf(result)).toBe('parent-missing')
    if (!result.ok) expect(result.message).toContain('create_directory')
  })

  test('refuses a parent that is a file', async () => {
    await writeFile(join(sandbox.root, 'plainfile'), 'x')
    expect(problemOf(await writeNewFile(await sandbox.resolve('plainfile', 'x.txt'), 'x'))).toBe('not-a-directory')
  })

  test('refuses a parent swapped for a symlink after resolve', async () => {
    await mkdir(join(sandbox.root, 'p1'))
    await mkdir(join(sandbox.root, 'elsewhere'))
    const target = await sandbox.resolve('p1', 'x.txt')
    await rename(join(sandbox.root, 'p1'), join(sandbox.root, 'p1-moved'))
    await symlink(join(sandbox.root, 'elsewhere'), join(sandbox.root, 'p1'))
    expect(problemOf(await writeNewFile(target, 'x'))).toBe('changed')
    expect(await namesIn(join(sandbox.root, 'elsewhere'))).toEqual([])
  })

  test('refuses content over the write limit', async () => {
    const big = 'a'.repeat(MAX_WRITE_BYTES + 1)
    expect(problemOf(await writeNewFile(await sandbox.resolve('big.txt'), big))).toBe('too-large')
    await expect(lstat(join(sandbox.root, 'big.txt'))).rejects.toThrow()
  })

  test('writes an empty file', async () => {
    valueOf(await writeNewFile(await sandbox.resolve('empty-new.txt'), ''))
    expect((await stat(join(sandbox.root, 'empty-new.txt'))).size).toBe(0)
  })
})

describe('replaceFile', () => {
  test('replaces the content and leaves no temp file', async () => {
    await mkdir(join(sandbox.root, 'rep'))
    await writeFile(join(sandbox.root, 'rep', 'a.txt'), 'old')
    const result = valueOf(await replaceFile(await sandbox.resolve('rep', 'a.txt'), 'new!'))
    expect(await readFile(join(sandbox.root, 'rep', 'a.txt'), 'utf8')).toBe('new!')
    expect(result.size).toBe(4)
    expect(await namesIn(join(sandbox.root, 'rep'))).toEqual(['a.txt'])
  })

  test.skipIf(process.platform === 'win32')('preserves the mode bits', async () => {
    const file = join(sandbox.root, 'mode.sh')
    await writeFile(file, 'old')
    await chmod(file, 0o751)
    valueOf(await replaceFile(await sandbox.resolve('mode.sh'), 'new'))
    expect((await stat(file)).mode & 0o777).toBe(0o751)
  })

  test('refuses a missing file and a folder', async () => {
    expect(problemOf(await replaceFile(await sandbox.resolve('nothing.txt'), 'x'))).toBe('not-found')
    await mkdir(join(sandbox.root, 'afolder'))
    expect(problemOf(await replaceFile(await sandbox.resolve('afolder'), 'x'))).toBe('not-a-file')
  })

  test('refuses a symlink swapped in after resolve and leaves its target alone', async () => {
    const file = join(sandbox.root, 'rsw.txt')
    await writeFile(file, 'orig')
    await writeFile(join(sandbox.root, 'outside-target.txt'), 'KEEP')
    const target = await sandbox.resolve('rsw.txt')
    await swapForSymlink(file, join(sandbox.root, 'outside-target.txt'))
    expect(problemOf(await replaceFile(target, 'EVIL'))).toBe('changed')
    expect(await readFile(join(sandbox.root, 'outside-target.txt'), 'utf8')).toBe('KEEP')
  })

  test('refuses a hard-linked file and leaves both names unchanged', async () => {
    await writeFile(join(sandbox.root, 'hl1.txt'), 'shared')
    await link(join(sandbox.root, 'hl1.txt'), join(sandbox.root, 'hl2.txt'))
    expect(problemOf(await replaceFile(await sandbox.resolve('hl1.txt'), 'x'))).toBe('hard-linked')
    expect(await readFile(join(sandbox.root, 'hl2.txt'), 'utf8')).toBe('shared')
  })

  test('refuses content over the write limit and keeps the old content', async () => {
    await writeFile(join(sandbox.root, 'keep.txt'), 'keep')
    const big = 'a'.repeat(MAX_WRITE_BYTES + 1)
    expect(problemOf(await replaceFile(await sandbox.resolve('keep.txt'), big))).toBe('too-large')
    expect(await readFile(join(sandbox.root, 'keep.txt'), 'utf8')).toBe('keep')
  })

  test('with a matching expected hash it replaces; with a different one it is stale', async () => {
    await writeFile(join(sandbox.root, 'hash.txt'), 'v1')
    const target = await sandbox.resolve('hash.txt')
    const sha = valueOf(await readText(target)).sha256
    expect(problemOf(await replaceFile(target, 'v2', 'f'.repeat(64)))).toBe('stale')
    expect(await readFile(join(sandbox.root, 'hash.txt'), 'utf8')).toBe('v1')
    valueOf(await replaceFile(target, 'v2', sha))
    expect(await readFile(join(sandbox.root, 'hash.txt'), 'utf8')).toBe('v2')
  })

  test.skipIf(process.platform === 'win32')('refuses a FIFO without blocking', async () => {
    execFileSync('mkfifo', [join(sandbox.root, 'rp.fifo')])
    expect(problemOf(await replaceFile(await sandbox.resolve('rp.fifo'), 'x'))).toBe('special-file')
  }, 5000)
})

describe('editFile', () => {
  async function fileWith(name: string, text: string) {
    await writeFile(join(sandbox.root, name), text)
    return sandbox.resolve(name)
  }

  test('applies an edit whose oldText occurs once and returns the new hash and size', async () => {
    const target = await fileWith('e1.txt', 'hello world')
    const result = valueOf(await editFile(target, [{ oldText: 'world', newText: 'there' }]))
    expect(await readFile(join(sandbox.root, 'e1.txt'), 'utf8')).toBe('hello there')
    expect(result.size).toBe(11)
    // the rename gave the path a new inode, so the old target is stale: a fresh resolve is needed
    expect(valueOf(await readText(await sandbox.resolve('e1.txt'))).sha256).toBe(result.sha256)
    expect(problemOf(await readText(target))).toBe('changed')
  })

  test('applies edits in order, each on the result of the previous', async () => {
    const target = await fileWith('e2.txt', 'a b')
    valueOf(await editFile(target, [{ oldText: 'a', newText: 'b1' }, { oldText: 'b1', newText: 'c' }]))
    expect(await readFile(join(sandbox.root, 'e2.txt'), 'utf8')).toBe('c b')
  })

  test('reports edit-mismatch with the index and count 0, and writes nothing', async () => {
    const target = await fileWith('e3.txt', 'abc')
    const result = await editFile(target, [{ oldText: 'b', newText: 'B' }, { oldText: 'zzz', newText: 'x' }])
    expect(problemOf(result)).toBe('edit-mismatch')
    if (!result.ok) expect(result.message).toMatch(/Edit 1.*0 times/)
    expect(await readFile(join(sandbox.root, 'e3.txt'), 'utf8')).toBe('abc')
  })

  test('reports edit-mismatch, found more than once, when oldText is ambiguous', async () => {
    const target = await fileWith('e4.txt', 'x x')
    const result = await editFile(target, [{ oldText: 'x', newText: 'y' }])
    expect(problemOf(result)).toBe('edit-mismatch')
    if (!result.ok) expect(result.message).toMatch(/Edit 0.*found more than once/)
  })

  test('counts overlapping occurrences as ambiguous', async () => {
    const target = await fileWith('e5.txt', 'aaa')
    expect(problemOf(await editFile(target, [{ oldText: 'aa', newText: 'b' }]))).toBe('edit-mismatch')
  })

  test('a long oldText that indexOf would take minutes over is settled in well under a few seconds', async () => {
    const target = await fileWith('big.txt', 'a'.repeat(4 * 1024 * 1024))
    const needle = `${'a'.repeat(16 * 1024)}b${'a'.repeat(16 * 1024)}`

    const started = performance.now()
    const result = await editFile(target, [{ oldText: needle, newText: 'x' }])

    expect(problemOf(result)).toBe('edit-mismatch')
    if (!result.ok) expect(result.message).toMatch(/found 0 times/)
    expect(performance.now() - started).toBeLessThan(3_000)
  })

  test('refuses an empty oldText and an empty edit list', async () => {
    const target = await fileWith('e6.txt', 'abc')
    expect(problemOf(await editFile(target, [{ oldText: '', newText: 'x' }]))).toBe('edit-mismatch')
    expect(problemOf(await editFile(target, []))).toBe('edit-mismatch')
  })

  test('inserts newText literally, without replacement patterns', async () => {
    const target = await fileWith('e7.txt', 'price: X')
    valueOf(await editFile(target, [{ oldText: 'X', newText: '$& $1 $$' }]))
    expect(await readFile(join(sandbox.root, 'e7.txt'), 'utf8')).toBe('price: $& $1 $$')
  })

  test('is stale when the expected hash is not the current content', async () => {
    const target = await fileWith('e8.txt', 'abc')
    expect(problemOf(await editFile(target, [{ oldText: 'a', newText: 'b' }], '0'.repeat(64)))).toBe('stale')
    expect(await readFile(join(sandbox.root, 'e8.txt'), 'utf8')).toBe('abc')
  })

  test('refuses binary content and hard-linked files', async () => {
    await writeFile(join(sandbox.root, 'e9.bin'), Buffer.from([1, 0, 2]))
    expect(problemOf(await editFile(await sandbox.resolve('e9.bin'), [{ oldText: 'a', newText: 'b' }]))).toBe('binary')
    const target = await fileWith('e10.txt', 'abc')
    await link(join(sandbox.root, 'e10.txt'), join(sandbox.root, 'e10b.txt'))
    expect(problemOf(await editFile(target, [{ oldText: 'a', newText: 'b' }]))).toBe('hard-linked')
  })

  test('refuses a symlink swapped in after resolve', async () => {
    const target = await fileWith('e11.txt', 'abc')
    await writeFile(join(sandbox.root, 'e11-victim.txt'), 'abc')
    await swapForSymlink(join(sandbox.root, 'e11.txt'), join(sandbox.root, 'e11-victim.txt'))
    expect(problemOf(await editFile(target, [{ oldText: 'a', newText: 'b' }]))).toBe('changed')
    expect(await readFile(join(sandbox.root, 'e11-victim.txt'), 'utf8')).toBe('abc')
  })

  test('refuses a result over the write limit', async () => {
    const target = await fileWith('e12.txt', 'x')
    const edits = [{ oldText: 'x', newText: 'a'.repeat(MAX_WRITE_BYTES + 1) }]
    expect(problemOf(await editFile(target, edits))).toBe('too-large')
  })
})

