import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { TRASH_DIR_NAME } from '../../src/files/constants.js'
import { prepareRoot } from '../../src/files/roots-admin.js'

const isPosix = process.platform !== 'win32'
let base: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-roots-admin-')))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

async function folder(name: string): Promise<string> {
  const dir = join(base, name)
  await mkdir(dir, { recursive: true })
  return dir
}

function expectRefused(result: Awaited<ReturnType<typeof prepareRoot>>, pattern: RegExp): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.message).toMatch(pattern)
  expect(result.message).not.toContain('\n')
}

describe('prepareRoot', () => {
  test('returns the canonical path and creates the trash', async () => {
    const dir = await folder('data')

    const result = await prepareRoot(dir)

    expect(result).toEqual({ ok: true, path: dir, trashCreated: true })
    expect((await stat(join(dir, TRASH_DIR_NAME))).isDirectory()).toBe(true)
  })

  test.runIf(isPosix)('creates the trash with mode 0700', async () => {
    const dir = await folder('data')

    await prepareRoot(dir)

    expect((await stat(join(dir, TRASH_DIR_NAME))).mode & 0o777).toBe(0o700)
  })

  test('canonicalises a path given through a symlink', async () => {
    const dir = await folder('real')
    const link = join(base, 'link')
    await symlink(dir, link)

    const result = await prepareRoot(link)

    expect(result.ok && result.path).toBe(dir)
  })

  test('is idempotent: an existing real trash is kept, trashCreated=false', async () => {
    const dir = await folder('data')
    await prepareRoot(dir)

    const result = await prepareRoot(dir)

    expect(result).toEqual({ ok: true, path: dir, trashCreated: false })
  })

  test('refuses a relative path', async () => {
    expectRefused(await prepareRoot('data/x'), /absolute/)
  })

  test('refuses an empty path and a NUL byte', async () => {
    expectRefused(await prepareRoot(''), /absolute|empty/)
    expectRefused(await prepareRoot('/tmp/\u0000x'), /NUL/)
  })

  test('refuses a missing folder with a hint to create it', async () => {
    expectRefused(await prepareRoot(join(base, 'nope')), /does not exist.*mkdir/)
  })

  test('refuses a file', async () => {
    const file = join(base, 'f.txt')
    await writeFile(file, 'x')

    expectRefused(await prepareRoot(file), /not a folder/)
  })

  test('refuses a folder with a trash-like segment in its canonical path', async () => {
    const dir = await folder(`a/${TRASH_DIR_NAME}/b`)

    expectRefused(await prepareRoot(dir), /trash/)
  })

  test('refuses a trash-like segment spelled with a folding character', async () => {
    const dir = await folder('.mcpcut-traſh')

    expectRefused(await prepareRoot(dir), /trash/)
  })

  test('refuses a folder inside the trash of an existing root', async () => {
    const root = await folder('root')
    await prepareRoot(root)
    const inside = await folder(`root/${TRASH_DIR_NAME}`)

    expectRefused(await prepareRoot(inside, [root]), /trash/)
  })

  test('allows a root nested in another root', async () => {
    const root = await folder('root')
    const nested = await folder('root/sub')

    const result = await prepareRoot(nested, [root])

    expect(result.ok && result.path).toBe(nested)
  })

  test.runIf(isPosix)('refuses a pre-existing symlink named like the trash, and leaves it alone', async () => {
    const dir = await folder('data')
    const elsewhere = await folder('elsewhere')
    await symlink(elsewhere, join(dir, TRASH_DIR_NAME))

    expectRefused(await prepareRoot(dir), /symbolic link.*remove/)
  })

  test('refuses a pre-existing plain file named like the trash', async () => {
    const dir = await folder('data')
    await writeFile(join(dir, TRASH_DIR_NAME), 'x')

    expectRefused(await prepareRoot(dir), /not a folder.*remove or rename/)
  })

  test.runIf(isPosix && typeof process.getuid === 'function' && process.getuid() === 0)(
    'refuses a trash owned by another user',
    async () => {
      const dir = await folder('data')
      await mkdir(join(dir, TRASH_DIR_NAME))
      const { chown } = await import('node:fs/promises')
      await chown(join(dir, TRASH_DIR_NAME), 12345, 12345)

      expectRefused(await prepareRoot(dir), /owned by another user/)
    },
  )

  test.runIf(isPosix)('reports an unwritable root in one line', async () => {
    if (process.getuid?.() === 0) return
    const dir = await folder('ro')
    const { chmod } = await import('node:fs/promises')
    await chmod(dir, 0o500)

    try {
      expectRefused(await prepareRoot(dir), /cannot create/)
    } finally {
      await chmod(dir, 0o700)
    }
  })
})

describe('prepareRoot: a pre-existing trash folder (M4)', () => {
  const INSPECT = /inspect.*remove or rename/

  test.runIf(isPosix)('refuses a trash with a mode other than 700', async () => {
    const dir = await folder('data')
    await mkdir(join(dir, TRASH_DIR_NAME))
    await chmod(join(dir, TRASH_DIR_NAME), 0o755)

    expectRefused(await prepareRoot(dir), /mode 755.*700/)
  })

  test.runIf(isPosix)('refuses a trash holding a foreign file', async () => {
    const dir = await folder('data')
    await mkdir(join(dir, TRASH_DIR_NAME), { mode: 0o700 })
    await writeFile(join(dir, TRASH_DIR_NAME, 'payload.sh'), 'x')

    expectRefused(await prepareRoot(dir), INSPECT)
  })

  test.runIf(isPosix)('accepts a valid existing trash and does not recreate it', async () => {
    const dir = await folder('data')
    const trash = join(dir, TRASH_DIR_NAME)
    await mkdir(join(trash, '01K9Z3Q8M5R7T2V4X6B8D0F1GH'), { recursive: true, mode: 0o700 })
    await writeFile(join(trash, '01K9Z3Q8M5R7T2V4X6B8D0F1GH.json'), '{}')
    await writeFile(join(trash, '.manifest-01K9Z3Q8M5R7T2V4X6B8D0F1GH.tmp'), '{}')
    await chmod(trash, 0o700)

    expect(await prepareRoot(dir)).toEqual({ ok: true, path: dir, trashCreated: false })
  })

  test.runIf(isPosix)('accepts an empty trash with mode 700', async () => {
    const dir = await folder('data')
    await mkdir(join(dir, TRASH_DIR_NAME), { mode: 0o700 })
    await chmod(join(dir, TRASH_DIR_NAME), 0o700)

    expect((await prepareRoot(dir)).ok).toBe(true)
  })
})
