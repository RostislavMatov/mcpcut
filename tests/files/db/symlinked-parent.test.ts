import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { hashCatalogFile } from '../../../src/files/db/catalog-hash.js'
import { readIndexable } from '../../../src/files/search/read-indexable.js'

/**
 * A folder inside a root swapped for a symlink to a private folder elsewhere
 * (by any local process that can write there) must not get that folder's text
 * hashed into the catalog or read into the index: the hash and the text would
 * stay after the swap back, under a path the agent may read. O_NOFOLLOW guards
 * only the last name, so the folders on the way are checked too.
 */

const isPosix = process.platform !== 'win32'
let base: string
let root: string
let secret: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-symlinked-parent-')))
  root = join(base, 'root')
  secret = join(base, 'private')
  await mkdir(join(root, 'mine', 'real'), { recursive: true })
  await mkdir(secret, { recursive: true })
  await writeFile(join(secret, 'a.txt'), 'TOP SECRET plan\n')
  await writeFile(join(root, 'mine', 'real', 'a.txt'), 'plain text\n')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

describe.skipIf(!isPosix)('a symlinked folder on the way to a file', () => {
  test('the catalog does not hash a file reached through it', async () => {
    await symlink(secret, join(root, 'mine', 'sub'))
    const file = join(root, 'mine', 'sub', 'a.txt')

    expect(await hashCatalogFile(file, await lstat(file, { bigint: true }))).toBeNull()
  })

  test('the indexer does not read a file reached through it, even with the right hash', async () => {
    await symlink(secret, join(root, 'mine', 'sub'))

    expect(await readIndexable(join(root, 'mine', 'sub', 'a.txt'), sha('TOP SECRET plan\n'))).toEqual({ kind: 'changed' })
  })

  test('a file under real folders is hashed and read as before', async () => {
    const file = join(root, 'mine', 'real', 'a.txt')

    expect(await hashCatalogFile(file, await lstat(file, { bigint: true }))).toBe(sha('plain text\n'))
    expect(await readIndexable(file, sha('plain text\n'))).toEqual({ kind: 'text', text: 'plain text\n' })
  })
})
