import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { hashCatalogFile } from '../../../src/files/db/catalog-hash.js'
import { refreshCatalogPaths, walkRoots } from '../../../src/files/db/catalog-walk.js'
import { openFilesDb, type FilesDb } from '../../../src/files/db/connection.js'
import { loadPg } from '../../../src/files/db/pg-loader.js'
import { describePg, PG_URL, withTestSchema } from './pg-helpers.js'

let root: string
let db: FilesDb
let cleanup: () => Promise<void>
const NOW = new Date('2026-10-05T12:00:00.000Z')

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-catalog-')))
  const schema = withTestSchema()
  cleanup = schema.cleanup
  if (PG_URL !== '') db = await openFilesDb({ pg: await loadPg(process.cwd()), url: PG_URL, schema: schema.schema })
})

afterEach(async () => {
  if (PG_URL !== '') {
    await db.close()
    await cleanup()
  }
  await rm(root, { recursive: true, force: true })
})

interface Row {
  rel_path: string
  kind: string
  size: string
  sha256: string | null
}

const rows = async () => (await db.query<Row>('SELECT rel_path, kind, size, sha256 FROM catalog ORDER BY rel_path')).rows
const walk = (extra: Partial<Parameters<typeof walkRoots>[1]> = {}) => walkRoots(db, { roots: [root], now: NOW, ...extra })
const SHA_HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

describePg('walkRoots on a real Postgres', () => {
  test('records files and folders with size and sha256, relative with slashes', async () => {
    await mkdir(join(root, 'docs', 'deep'), { recursive: true })
    await writeFile(join(root, 'docs', 'a.txt'), 'hello')

    const [result] = await walk()

    expect(result).toMatchObject({ root, files: 1, dirs: 2, added: 3, changed: 0, removed: 0, truncated: false })
    expect(await rows()).toEqual([
      { rel_path: 'docs', kind: 'dir', size: '0', sha256: null },
      { rel_path: 'docs/a.txt', kind: 'file', size: '5', sha256: SHA_HELLO },
      { rel_path: 'docs/deep', kind: 'dir', size: '0', sha256: null },
    ])
  })

  test('counts what was added, changed and removed on the next walk', async () => {
    await writeFile(join(root, 'keep.txt'), 'k')
    await writeFile(join(root, 'edit.txt'), 'one')
    await writeFile(join(root, 'gone.txt'), 'g')
    await walk()
    await writeFile(join(root, 'edit.txt'), 'longer text')
    await rm(join(root, 'gone.txt'))
    await writeFile(join(root, 'new.txt'), 'n')

    const [result] = await walk({ now: new Date('2026-10-05T12:01:00.000Z') })

    expect(result).toMatchObject({ added: 1, changed: 1, removed: 1 })
    expect((await rows()).map((row) => row.rel_path)).toEqual(['edit.txt', 'keep.txt', 'new.txt'])
  })

  test('symlinks are skipped, the trash is not walked', async () => {
    await writeFile(join(root, 'real.txt'), 'r')
    await symlink(join(root, 'real.txt'), join(root, 'link.txt'))
    await mkdir(join(root, '.mcpcut-trash', 'T1'), { recursive: true })
    await writeFile(join(root, '.mcpcut-trash', 'T1', 'x'), 'x')

    await walk()

    expect((await rows()).map((row) => row.rel_path)).toEqual(['real.txt'])
  })

  test('a file is hashed again only when its size or mtime moved', async () => {
    await writeFile(join(root, 'a.txt'), 'hello')
    const hash = vi.fn(hashCatalogFile)
    await walk({ hash })
    await walk({ hash })
    expect(hash).toHaveBeenCalledTimes(1)
    await utimes(join(root, 'a.txt'), new Date('2020-01-01'), new Date('2020-01-01'))
    await walk({ hash })
    expect(hash).toHaveBeenCalledTimes(2)
  })

  test('a file larger than the hash limit is recorded without a hash', async () => {
    await writeFile(join(root, 'big.bin'), 'x'.repeat(100))
    await walk({ hashMaxBytes: 10 })
    expect((await rows())[0]).toMatchObject({ rel_path: 'big.bin', size: '100', sha256: null })
  })

  test('over maxEntries the walk is truncated and deletes nothing', async () => {
    await writeFile(join(root, 'a.txt'), 'a')
    await writeFile(join(root, 'b.txt'), 'b')
    await writeFile(join(root, 'c.txt'), 'c')
    await walk()
    await rm(join(root, 'a.txt'))

    const [result] = await walk({ maxEntries: 1 })

    expect(result).toMatchObject({ truncated: true, removed: 0 })
    expect(await rows()).toHaveLength(3)
  })

  test('a root that is gone reports an error and keeps its rows', async () => {
    await writeFile(join(root, 'a.txt'), 'a')
    await walk()
    const missing = join(root, 'nowhere')

    const [result] = await walkRoots(db, { roots: [missing, root], now: NOW })

    expect(result?.error).toContain('gone or cannot be read')
    expect(await rows()).toHaveLength(1)
  })
})

describePg('walk limits', () => {
  const LONG_NAME = 'n'.repeat(200)

  test('an entry whose path passes 600 code points is skipped and not descended into', async () => {
    const deep = join(root, LONG_NAME, LONG_NAME, LONG_NAME)
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, 'inside.txt'), 'x')

    const [result] = await walk()

    expect(result).toMatchObject({ dirs: 2, files: 0, skipped: 1 })
    expect((await rows()).map((row) => row.rel_path)).toEqual([LONG_NAME, `${LONG_NAME}/${LONG_NAME}`])
  })

  test('a root whose own path passes 600 code points records nothing and counts as skipped', async () => {
    const longRoot = join(root, LONG_NAME, LONG_NAME, LONG_NAME, 'r')
    await mkdir(longRoot, { recursive: true })
    await writeFile(join(longRoot, 'a.txt'), 'a')

    const [result] = await walkRoots(db, { roots: [longRoot], now: NOW })

    expect(result).toMatchObject({ root: longRoot, files: 0, dirs: 0, skipped: 1 })
    expect(result?.error).toBeUndefined()
    expect(await rows()).toEqual([])
  })

  test('over the hashing budget changed files are recorded without a hash and a later walk hashes them', async () => {
    await writeFile(join(root, 'a.txt'), 'a'.repeat(100))
    await writeFile(join(root, 'b.txt'), 'b'.repeat(100))
    const hash = vi.fn(hashCatalogFile)

    const [first] = await walk({ hash, hashBudgetBytes: 150 })

    expect(first).toMatchObject({ hashDeferred: 1 })
    expect(hash).toHaveBeenCalledTimes(1)
    expect((await rows()).filter((row) => row.sha256 === null)).toHaveLength(1)

    const [second] = await walk({ hash })

    expect(second).toMatchObject({ hashDeferred: 0, changed: 1 })
    expect(hash).toHaveBeenCalledTimes(2)
    expect((await rows()).every((row) => row.sha256 !== null)).toBe(true)
  })

  test('the hashing budget is shared by the roots of one walk', async () => {
    const other = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-catalog-b-')))
    try {
      await writeFile(join(root, 'a.txt'), 'a'.repeat(100))
      await writeFile(join(other, 'b.txt'), 'b'.repeat(100))
      const results = await walkRoots(db, { roots: [root, other], now: NOW, hashBudgetBytes: 100 })
      expect(results.map((one) => one.hashDeferred)).toEqual([0, 1])
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  test('a row refreshed after the walk started survives the walk deleting what it did not see', async () => {
    await db.query(
      "INSERT INTO catalog (root, rel_path, kind, size, mtime_ms, sha256, seen_at) VALUES ($1, 'older', 'file', 1, 1, NULL, $2), ($1, 'newer', 'file', 1, 1, NULL, $3)",
      [root, '2026-10-05T11:00:00.000Z', '2026-10-05T12:00:01.000Z'],
    )

    const [result] = await walk()

    expect(result).toMatchObject({ removed: 1 })
    expect((await rows()).map((row) => row.rel_path)).toEqual(['newer'])
  })
})

describePg('refreshCatalogPaths on a real Postgres', () => {
  test('a present path is upserted; an absent one is deleted, a folder with its subtree', async () => {
    await mkdir(join(root, 'dir'), { recursive: true })
    await writeFile(join(root, 'dir', 'a.txt'), 'hello')
    await writeFile(join(root, 'dir', 'b.txt'), 'b')
    await writeFile(join(root, 'dirty.txt'), 'd')
    await walk()
    await writeFile(join(root, 'dir', 'a.txt'), 'hello world')
    await writeFile(join(root, 'fresh.txt'), 'f')
    await rm(join(root, 'dir'), { recursive: true })

    await refreshCatalogPaths(db, { roots: [root], paths: [join(root, 'dir', 'a.txt'), join(root, 'fresh.txt'), join(root, 'dir'), '/outside/x', 'relative'], now: NOW })

    expect((await rows()).map((row) => row.rel_path)).toEqual(['dirty.txt', 'fresh.txt'])
  })

  test('a name that merely starts like the folder is not deleted with it', async () => {
    await mkdir(join(root, 'a'))
    await mkdir(join(root, 'a_b'))
    await writeFile(join(root, 'a_b', 'x'), 'x')
    await walk()
    await rm(join(root, 'a'), { recursive: true })

    await refreshCatalogPaths(db, { roots: [root], paths: [join(root, 'a')], now: NOW })

    expect((await rows()).map((row) => row.rel_path)).toEqual(['a_b', 'a_b/x'])
  })

  test('every declared root that holds the path gets the row, nested roots included', async () => {
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'f.txt'), 'f')
    const inner = join(root, 'sub')

    await refreshCatalogPaths(db, { roots: [root, inner], paths: [join(inner, 'f.txt')], now: NOW })

    const found = await db.query<{ root: string; rel_path: string }>('SELECT root, rel_path FROM catalog ORDER BY root')
    expect(found.rows).toEqual([
      { root, rel_path: 'sub/f.txt' },
      { root: inner, rel_path: 'f.txt' },
    ])
  })
})
