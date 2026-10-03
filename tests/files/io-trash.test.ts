import { execFileSync } from 'node:child_process'
import { link, lstat, mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { TRASH_DIR_NAME } from '../../src/files/constants.js'
import { listDirectory } from '../../src/files/io-read.js'
import { moveToTrash } from '../../src/files/io-trash.js'
import { listTrash, purgeTrash, restoreFromTrash } from '../../src/files/io-trash-admin.js'
import { makeSandbox, namesIn, problemOf, valueOf, type Sandbox } from './io-helpers.js'

/**
 * ADR-0020 §4: delete is a `rename` into `<root>/.mcpcut-trash/<ulid>/` with a
 * manifest beside it. Only an administrator lists, restores and purges; an id
 * is validated before any path is built from it, a manifest is never trusted.
 */

let sandbox: Sandbox

beforeAll(async () => {
  sandbox = await makeSandbox('trash')
})

afterAll(async () => {
  await sandbox.cleanup()
})

beforeEach(async () => {
  const names = await namesIn(sandbox.trash)
  await Promise.all(names.map((name) => rm(join(sandbox.trash, name), { recursive: true, force: true })))
})

const DAY_MS = 24 * 60 * 60 * 1000

describe('moveToTrash', () => {
  test('moves a file into <trash>/<ulid>/<name> and writes the manifest', async () => {
    await mkdir(join(sandbox.root, 'docs'), { recursive: true })
    await writeFile(join(sandbox.root, 'docs', 'note.txt'), 'bye')
    const manifest = valueOf(await moveToTrash(await sandbox.resolve('docs', 'note.txt'), 'agent-me'))
    await expect(lstat(join(sandbox.root, 'docs', 'note.txt'))).rejects.toThrow()
    expect(await readFile(join(sandbox.trash, manifest.id, 'note.txt'), 'utf8')).toBe('bye')
    expect(manifest).toMatchObject({
      root: sandbox.root,
      relative: join('docs', 'note.txt'),
      originalPath: join(sandbox.root, 'docs', 'note.txt'),
      kind: 'file',
      size: 3,
      deletedBy: 'agent-me',
    })
    expect(manifest.sha256).toHaveLength(64)
    expect(new Date(manifest.deletedAt).toISOString()).toBe(manifest.deletedAt)
    const onDisk = JSON.parse(await readFile(join(sandbox.trash, `${manifest.id}.json`), 'utf8')) as unknown
    expect(onDisk).toEqual(manifest)
    if (process.platform !== 'win32') {
      expect((await stat(join(sandbox.trash, manifest.id))).mode & 0o777).toBe(0o700)
      expect((await stat(join(sandbox.trash, `${manifest.id}.json`))).mode & 0o777).toBe(0o600)
    }
  })

  test('moves a folder whole and records its kind', async () => {
    await mkdir(join(sandbox.root, 'proj', 'src'), { recursive: true })
    await writeFile(join(sandbox.root, 'proj', 'src', 'a.ts'), 'a')
    const manifest = valueOf(await moveToTrash(await sandbox.resolve('proj'), 'me'))
    expect(manifest.kind).toBe('directory')
    expect(manifest.sha256).toBeUndefined()
    expect(await readFile(join(sandbox.trash, manifest.id, 'proj', 'src', 'a.ts'), 'utf8')).toBe('a')
  })

  test('the trash is not listed by listDirectory', async () => {
    await writeFile(join(sandbox.root, 'tl.txt'), 'x')
    valueOf(await moveToTrash(await sandbox.resolve('tl.txt'), 'me'))
    const names = valueOf(await listDirectory(await sandbox.resolve())).entries.map((entry) => entry.name)
    expect(names).not.toContain(TRASH_DIR_NAME)
  })

  test('refuses with no-trash when the trash folder is missing, and tells the admin what to run', async () => {
    await writeFile(join(sandbox.root, 'nt.txt'), 'x')
    const target = await sandbox.resolve('nt.txt')
    await rename(sandbox.trash, `${sandbox.trash}-away`)
    const result = await moveToTrash(target, 'me')
    await rename(`${sandbox.trash}-away`, sandbox.trash)
    expect(problemOf(result)).toBe('no-trash')
    if (!result.ok) expect(result.message).toContain('mcpcut files root add')
    expect((await lstat(join(sandbox.root, 'nt.txt'))).isFile()).toBe(true)
  })

  test('refuses with no-trash when the trash is a symlink', async () => {
    await writeFile(join(sandbox.root, 'ns.txt'), 'x')
    await mkdir(join(sandbox.base, 'elsewhere'))
    const target = await sandbox.resolve('ns.txt')
    await rename(sandbox.trash, `${sandbox.trash}-away`)
    await symlink(join(sandbox.base, 'elsewhere'), sandbox.trash)
    const result = await moveToTrash(target, 'me')
    await rm(sandbox.trash)
    await rename(`${sandbox.trash}-away`, sandbox.trash)
    expect(problemOf(result)).toBe('no-trash')
    expect(await namesIn(join(sandbox.base, 'elsewhere'))).toEqual([])
  })

  test('refuses a symlink swapped in after resolve and leaves its target', async () => {
    await writeFile(join(sandbox.root, 'sw.txt'), 'x')
    await writeFile(join(sandbox.root, 'sw-victim.txt'), 'victim')
    const target = await sandbox.resolve('sw.txt')
    await rm(join(sandbox.root, 'sw.txt'))
    await symlink(join(sandbox.root, 'sw-victim.txt'), join(sandbox.root, 'sw.txt'))
    expect(problemOf(await moveToTrash(target, 'me'))).toBe('changed')
    expect(await readFile(join(sandbox.root, 'sw-victim.txt'), 'utf8')).toBe('victim')
    expect(await namesIn(sandbox.trash)).toEqual([])
  })

  test('refuses a hard-linked file', async () => {
    await writeFile(join(sandbox.root, 'hl1.txt'), 'x')
    await link(join(sandbox.root, 'hl1.txt'), join(sandbox.root, 'hl2.txt'))
    expect(problemOf(await moveToTrash(await sandbox.resolve('hl1.txt'), 'me'))).toBe('hard-linked')
    expect(await namesIn(sandbox.trash)).toEqual([])
  })

  test.skipIf(process.platform === 'win32')('refuses a FIFO', async () => {
    execFileSync('mkfifo', [join(sandbox.root, 'tp.fifo')])
    expect(problemOf(await moveToTrash(await sandbox.resolve('tp.fifo'), 'me'))).toBe('special-file')
  }, 5000)

  test('refuses a missing target and the root itself', async () => {
    expect(problemOf(await moveToTrash(await sandbox.resolve('absent'), 'me'))).toBe('not-found')
    expect(problemOf(await moveToTrash(await sandbox.resolve(), 'me'))).toBe('io-error')
  })

  test('skips the hash for a file over the read limit but still trashes it', async () => {
    const { truncate } = await import('node:fs/promises')
    await writeFile(join(sandbox.root, 'huge.dat'), '')
    await truncate(join(sandbox.root, 'huge.dat'), 10 * 1024 * 1024 + 1)
    const manifest = valueOf(await moveToTrash(await sandbox.resolve('huge.dat'), 'me'))
    expect(manifest.sha256).toBeUndefined()
    expect(manifest.size).toBe(10 * 1024 * 1024 + 1)
  })
})

describe('listTrash', () => {
  test('lists manifests, oldest first by id', async () => {
    await writeFile(join(sandbox.root, 'l1.txt'), '1')
    await writeFile(join(sandbox.root, 'l2.txt'), '2')
    const first = valueOf(await moveToTrash(await sandbox.resolve('l1.txt'), 'me'))
    const second = valueOf(await moveToTrash(await sandbox.resolve('l2.txt'), 'me'))
    const listing = valueOf(await listTrash(sandbox.root))
    expect(listing.entries.map((entry) => entry.id).sort()).toEqual([first.id, second.id].sort())
    expect(listing.skipped).toEqual([])
  })

  test('is empty for an empty trash and no-trash when there is none', async () => {
    expect(valueOf(await listTrash(sandbox.root)).entries).toEqual([])
    expect(problemOf(await listTrash(join(sandbox.base, 'no-such-root')))).toBe('no-trash')
  })

  test('skips and reports a corrupt manifest and one with a wrong id, never trusting it', async () => {
    const corruptId = ulid()
    const liarId = ulid()
    await writeFile(join(sandbox.trash, `${corruptId}.json`), '{not json')
    await writeFile(
      join(sandbox.trash, `${liarId}.json`),
      JSON.stringify({ id: ulid(), root: sandbox.root, relative: 'x', originalPath: join(sandbox.root, 'x'), kind: 'file', size: 1, deletedAt: new Date().toISOString(), deletedBy: 'me' }),
    )
    const listing = valueOf(await listTrash(sandbox.root))
    expect(listing.entries).toEqual([])
    expect(listing.skipped.map((item) => item.id).sort()).toEqual([corruptId, liarId].sort())
  })

  test('skips a manifest with extra or missing fields and ignores other files', async () => {
    const id = ulid()
    await writeFile(join(sandbox.trash, `${id}.json`), JSON.stringify({ id, root: '/r' }))
    await writeFile(join(sandbox.trash, 'README.txt'), 'x')
    const listing = valueOf(await listTrash(sandbox.root))
    expect(listing.skipped.map((item) => item.id)).toEqual([id])
  })
})

describe('restoreFromTrash', () => {
  test('round trip: the file returns to its original path with its content', async () => {
    await mkdir(join(sandbox.root, 'rt'), { recursive: true })
    await writeFile(join(sandbox.root, 'rt', 'a.txt'), 'back')
    const manifest = valueOf(await moveToTrash(await sandbox.resolve('rt', 'a.txt'), 'me'))
    const restored = valueOf(await restoreFromTrash(sandbox.root, manifest.id))
    expect(restored.id).toBe(manifest.id)
    expect(await readFile(join(sandbox.root, 'rt', 'a.txt'), 'utf8')).toBe('back')
    expect(await namesIn(sandbox.trash)).toEqual([])
  })

  test('round trip for a folder', async () => {
    await mkdir(join(sandbox.root, 'rf', 'in'), { recursive: true })
    await writeFile(join(sandbox.root, 'rf', 'in', 'a.txt'), 'deep')
    const manifest = valueOf(await moveToTrash(await sandbox.resolve('rf'), 'me'))
    valueOf(await restoreFromTrash(sandbox.root, manifest.id))
    expect(await readFile(join(sandbox.root, 'rf', 'in', 'a.txt'), 'utf8')).toBe('deep')
  })

  test('refuses when the original path exists now and keeps the trash entry', async () => {
    await writeFile(join(sandbox.root, 're.txt'), 'old')
    const manifest = valueOf(await moveToTrash(await sandbox.resolve('re.txt'), 'me'))
    await writeFile(join(sandbox.root, 're.txt'), 'new')
    expect(problemOf(await restoreFromTrash(sandbox.root, manifest.id))).toBe('exists')
    expect(await readFile(join(sandbox.root, 're.txt'), 'utf8')).toBe('new')
    expect(await namesIn(sandbox.trash)).toContain(manifest.id)
  })

  test('refuses with parent-missing when the folder is gone and recreates nothing', async () => {
    await mkdir(join(sandbox.root, 'pm'))
    await writeFile(join(sandbox.root, 'pm', 'a.txt'), 'x')
    const manifest = valueOf(await moveToTrash(await sandbox.resolve('pm', 'a.txt'), 'me'))
    await rm(join(sandbox.root, 'pm'), { recursive: true })
    expect(problemOf(await restoreFromTrash(sandbox.root, manifest.id))).toBe('parent-missing')
    await expect(lstat(join(sandbox.root, 'pm'))).rejects.toThrow()
  })

  test.each(['../etc', '..', '', 'abc', 'x/../y', ulid().toLowerCase(), `${ulid()}/..`, `${ulid()}\u0000`])(
    'refuses the bad id %j before touching any path',
    async (id) => {
      expect(problemOf(await restoreFromTrash(sandbox.root, id))).toBe('not-found')
    },
  )

  test('refuses a valid id with no entry', async () => {
    expect(problemOf(await restoreFromTrash(sandbox.root, ulid()))).toBe('not-found')
  })

  test('refuses a tampered manifest whose relative path escapes the root', async () => {
    const id = ulid()
    await mkdir(join(sandbox.trash, id))
    await writeFile(join(sandbox.trash, id, 'evil'), 'x')
    const manifest = { id, root: sandbox.root, relative: '../escape', originalPath: join(sandbox.base, 'escape'), kind: 'file', size: 1, deletedAt: new Date().toISOString(), deletedBy: 'me' }
    await writeFile(join(sandbox.trash, `${id}.json`), JSON.stringify(manifest))
    expect(problemOf(await restoreFromTrash(sandbox.root, id))).toBe('io-error')
    await expect(lstat(join(sandbox.base, 'escape'))).rejects.toThrow()
  })

  test('refuses no-trash for a root without a trash', async () => {
    expect(problemOf(await restoreFromTrash(join(sandbox.base, 'no-root'), ulid()))).toBe('no-trash')
  })
})

describe('purgeTrash', () => {
  async function trashedAt(name: string, ageMs: number, now: number) {
    await writeFile(join(sandbox.root, name), name)
    const manifest = valueOf(await moveToTrash(await sandbox.resolve(name), 'me'))
    const path = join(sandbox.trash, `${manifest.id}.json`)
    const aged = { ...manifest, deletedAt: new Date(now - ageMs).toISOString() }
    await writeFile(path, JSON.stringify(aged))
    await utimes(path, new Date(), new Date())
    return manifest.id
  }

  test('removes entries and manifests older than the cutoff and keeps newer ones', async () => {
    const now = Date.now()
    const oldId = await trashedAt('old.txt', 31 * DAY_MS, now)
    const freshId = await trashedAt('fresh.txt', 1 * DAY_MS, now)
    const result = valueOf(await purgeTrash(sandbox.root, 30 * DAY_MS, now))
    expect(result.purged).toBe(1)
    expect(await namesIn(sandbox.trash)).toEqual([freshId, `${freshId}.json`].sort())
    expect(await namesIn(sandbox.trash)).not.toContain(oldId)
  })

  test('purges nothing from an empty trash and reports no-trash without one', async () => {
    expect(valueOf(await purgeTrash(sandbox.root, DAY_MS, Date.now())).purged).toBe(0)
    expect(problemOf(await purgeTrash(join(sandbox.base, 'no-root'), DAY_MS, Date.now()))).toBe('no-trash')
  })

  test('skips a corrupt manifest and reports it', async () => {
    const id = ulid()
    await writeFile(join(sandbox.trash, `${id}.json`), 'garbage')
    const result = valueOf(await purgeTrash(sandbox.root, 0, Date.now() + DAY_MS))
    expect(result.purged).toBe(0)
    expect(result.skipped.map((item) => item.id)).toEqual([id])
    expect(await namesIn(sandbox.trash)).toEqual([`${id}.json`])
  })

  test('refuses a negative or non-finite age', async () => {
    expect(problemOf(await purgeTrash(sandbox.root, -1, Date.now()))).toBe('io-error')
    expect(problemOf(await purgeTrash(sandbox.root, Number.NaN, Date.now()))).toBe('io-error')
  })
})
