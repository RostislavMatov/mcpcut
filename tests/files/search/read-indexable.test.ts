import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { INDEX_MAX_FILE_BYTES } from '../../../src/files/search/constants.js'
import { readCapped, readIndexable } from '../../../src/files/search/read-indexable.js'

let dir: string
const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

beforeEach(async () => {
  // Canonical, as roots are stored: files under a symlinked folder are refused.
  dir = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-read-indexable-')))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function put(name: string, data: string | Buffer): Promise<string> {
  const file = join(dir, name)
  await writeFile(file, data)
  return file
}

describe('readIndexable', () => {
  test('returns the text of a file whose hash is the expected one', async () => {
    const file = await put('a.md', 'hello мир')

    expect(await readIndexable(file, sha('hello мир'))).toEqual({ kind: 'text', text: 'hello мир' })
  })

  test('strips a leading byte order mark', async () => {
    const data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('body')])
    const file = await put('bom.md', data)

    expect(await readIndexable(file, sha(data))).toEqual({ kind: 'text', text: 'body' })
  })

  test('a changed file is reported as changed, not indexed', async () => {
    const file = await put('a.md', 'new')

    expect(await readIndexable(file, sha('old'))).toEqual({ kind: 'changed' })
  })

  test('a file with a NUL byte or invalid UTF-8 is binary', async () => {
    const withNul = await put('n.bin', Buffer.from('a\u0000b'))
    const invalid = await put('i.bin', Buffer.from([0xff, 0xfe, 0x41]))

    expect(await readIndexable(withNul, sha(Buffer.from('a\u0000b')))).toEqual({ kind: 'skip', reason: 'binary' })
    expect(await readIndexable(invalid, sha(Buffer.from([0xff, 0xfe, 0x41])))).toEqual({ kind: 'skip', reason: 'binary' })
  })

  test('a file over the size limit is too large and is not read', async () => {
    const file = await put('big.txt', Buffer.alloc(INDEX_MAX_FILE_BYTES + 1, 0x61))

    expect(await readIndexable(file, 'whatever')).toEqual({ kind: 'skip', reason: 'too large' })
  })

  test('a symlink is never followed', async () => {
    const target = await put('real.md', 'secret')
    const link = join(dir, 'link.md')
    await symlink(target, link)

    expect(await readIndexable(link, sha('secret'))).toEqual({ kind: 'changed' })
  })

  test('a missing file is changed', async () => {
    expect(await readIndexable(join(dir, 'gone.md'), 'x')).toEqual({ kind: 'changed' })
  })

  test.skipIf(process.platform === 'win32')('a FIFO never blocks', async () => {
    const fifo = join(dir, 'pipe')
    execFileSync('mkfifo', [fifo])

    const outcome = await Promise.race([readIndexable(fifo, 'x'), new Promise((resolve) => setTimeout(() => resolve('blocked'), 2000))])

    expect(outcome).toEqual({ kind: 'changed' })
  })
})

describe('readCapped', () => {
  test('never asks for more than the limit plus one byte, however much the file has grown', async () => {
    const asked: number[] = []
    const handle = {
      read: async (buffer: Buffer, offset: number, length: number) => {
        asked.push(length)
        buffer.fill(97, offset, offset + length)
        return { bytesRead: length }
      },
    }

    const bytes = await readCapped(handle, 10)

    expect(bytes.length).toBe(11)
    expect(asked.reduce((sum, n) => sum + n, 0)).toBe(11)
  })

  test('stops at the end of a file that is shorter than the limit', async () => {
    let left = 4
    const handle = {
      read: async (buffer: Buffer, offset: number) => {
        const bytesRead = Math.min(left, 2)
        left -= bytesRead
        buffer.fill(98, offset, offset + bytesRead)
        return { bytesRead }
      },
    }

    expect((await readCapped(handle, 10)).toString()).toBe('bbbb')
  })
})
