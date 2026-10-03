import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { checkName, resolveWithinRoots, TRASH_DIR_NAME, type PathResult } from '../../src/files/paths.js'

/**
 * ADR-0020 §3: every path an agent names goes through ONE resolver before any
 * file is touched. The two past advisories of the reference filesystem server
 * set the floor — CVE-2025-53110 (a string-prefix check let `/allowed-evil`
 * pass for `/allowed`) and CVE-2025-53109 (a symlink inside the folder led
 * out of it). Containment is decided on canonical (`realpath.native`) paths,
 * segment by segment; anything that cannot be resolved is refused.
 */

let base: string
let root: string
let outside: string

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-files-paths-')))
  root = join(base, 'allowed')
  outside = join(base, 'outside')
  await mkdir(join(root, 'Data', 'sub'), { recursive: true })
  await mkdir(join(base, 'allowed-evil'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await mkdir(join(root, TRASH_DIR_NAME), { recursive: true })
  await writeFile(join(root, 'Data', 'a.txt'), 'a')
  await writeFile(join(base, 'allowed-evil', 'secret.txt'), 's')
  await writeFile(join(outside, 'secret.txt'), 's')
  await writeFile(join(root, TRASH_DIR_NAME, 'old.txt'), 'o')
  await symlink(join(outside, 'secret.txt'), join(root, 'link-out-file'))
  await symlink(outside, join(root, 'link-out-dir'))
  await symlink(join(root, 'Data', 'a.txt'), join(root, 'link-in'))
  await symlink(join(outside, 'not-yet.txt'), join(root, 'dangling-out'))
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

function expectOk(result: PathResult): asserts result is Extract<PathResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${result.refusal}: ${result.message}`)
}

function expectRefused(result: PathResult, refusal: string): void {
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.refusal).toBe(refusal)
    expect(result.message.length).toBeGreaterThan(0)
  }
}

describe('resolveWithinRoots — inside a root', () => {
  test('an existing file resolves to its canonical path, its root and the path relative to the root', async () => {
    const result = await resolveWithinRoots(join(root, 'Data', 'a.txt'), [root])
    expectOk(result)
    expect(result.path).toEqual({
      root,
      absolute: join(root, 'Data', 'a.txt'),
      relative: join('Data', 'a.txt'),
      exists: true,
    })
  })

  test('the root itself is inside, with an empty relative path', async () => {
    const result = await resolveWithinRoots(root, [root])
    expectOk(result)
    expect(result.path.relative).toBe('')
  })

  test('a file that does not exist yet resolves through its nearest existing parent', async () => {
    const result = await resolveWithinRoots(join(root, 'Data', 'new', 'deep', 'n.txt'), [root])
    expectOk(result)
    expect(result.path.absolute).toBe(join(root, 'Data', 'new', 'deep', 'n.txt'))
    expect(result.path.exists).toBe(false)
  })

  test('a symlink that stays inside the root resolves to its target', async () => {
    const result = await resolveWithinRoots(join(root, 'link-in'), [root])
    expectOk(result)
    expect(result.path.absolute).toBe(join(root, 'Data', 'a.txt'))
  })

  test('dot segments that stay inside are collapsed', async () => {
    const result = await resolveWithinRoots(join(root, 'Data', 'sub', '..', 'a.txt'), [root])
    expectOk(result)
    expect(result.path.absolute).toBe(join(root, 'Data', 'a.txt'))
  })

  test('a name that starts with two dots is a child, not an escape', async () => {
    const result = await resolveWithinRoots(join(root, '..notes'), [root])
    expectOk(result)
    expect(result.path.relative).toBe('..notes')
  })

  test('of nested roots the most specific one is reported', async () => {
    const inner = join(root, 'Data')
    const result = await resolveWithinRoots(join(inner, 'a.txt'), [root, inner])
    expectOk(result)
    expect(result.path.root).toBe(inner)
  })

  test.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    'on a case-insensitive volume a differently cased path resolves to the on-disk spelling',
    async () => {
      const result = await resolveWithinRoots(join(root, 'DATA', 'A.TXT'), [root])
      expectOk(result)
      expect(result.path.absolute).toBe(join(root, 'Data', 'a.txt'))
    },
  )

  test('a root named through a symlinked ancestor still matches the canonical path', async () => {
    const viaLink = join(root, 'link-to-data')
    await symlink(join(root, 'Data'), viaLink)
    const result = await resolveWithinRoots(join(root, 'Data', 'a.txt'), [viaLink])
    expectOk(result)
    expect(result.path.root).toBe(join(root, 'Data'))
  })
})

describe('resolveWithinRoots — refusals', () => {
  test('CVE-2025-53110: a sibling that shares the root as a string prefix is outside', async () => {
    expectRefused(await resolveWithinRoots(join(base, 'allowed-evil', 'secret.txt'), [root]), 'outside-roots')
  })

  test('dot segments that climb out of the root are outside', async () => {
    expectRefused(await resolveWithinRoots(join(root, 'Data', '..', '..', 'outside', 'secret.txt'), [root]), 'outside-roots')
  })

  test('CVE-2025-53109: a symlinked file that points outside is outside', async () => {
    expectRefused(await resolveWithinRoots(join(root, 'link-out-file'), [root]), 'outside-roots')
  })

  test('CVE-2025-53109: a new file under a symlinked folder that points outside is outside', async () => {
    expectRefused(await resolveWithinRoots(join(root, 'link-out-dir', 'new.txt'), [root]), 'outside-roots')
  })

  test('a dangling symlink is refused — writing to it would create a file wherever it points', async () => {
    expectRefused(await resolveWithinRoots(join(root, 'dangling-out'), [root]), 'dangling-symlink')
  })

  test('the trash folder and everything in it are unreachable', async () => {
    expectRefused(await resolveWithinRoots(join(root, TRASH_DIR_NAME), [root]), 'trash')
    expectRefused(await resolveWithinRoots(join(root, TRASH_DIR_NAME, 'old.txt'), [root]), 'trash')
  })

  test('the trash name is refused in any letter case, so an agent cannot pre-create it on a case-insensitive volume', async () => {
    const other = join(base, 'fresh-root')
    await mkdir(other, { recursive: true })
    expectRefused(await resolveWithinRoots(join(other, '.MCPCUT-Trash', 'x.txt'), [other]), 'trash')
  })

  test('a relative path is refused and the message points at list_roots', async () => {
    const result = await resolveWithinRoots(join('Data', 'a.txt'), [root])
    expectRefused(result, 'not-absolute')
    if (!result.ok) expect(result.message).toContain('list_roots')
  })

  test('no roots at all means nothing is inside', async () => {
    expectRefused(await resolveWithinRoots(join(root, 'Data', 'a.txt'), []), 'outside-roots')
  })

  test('a root that no longer exists is skipped, not trusted', async () => {
    expectRefused(await resolveWithinRoots(join(base, 'gone', 'x.txt'), [join(base, 'gone')]), 'outside-roots')
  })

  test.each<[label: string, input: string, refusal: string]>([
    ['empty', '', 'empty'],
    ['NUL byte', '/tmp/a\u0000b', 'nul-byte'],
    ['too long', `/${'a'.repeat(5000)}`, 'too-long'],
  ])('%s is refused before any file system call', async (_label, input, refusal) => {
    expectRefused(await resolveWithinRoots(input, [root]), refusal)
  })
})

describe('checkName — names Windows cannot hold safely', () => {
  test.each<[input: string]>([
    ['C:\\data\\report.txt:hidden'],
    ['C:\\data\\CON'],
    ['C:\\data\\nul.txt'],
    ['C:\\data\\com1'],
    ['C:\\data\\LPT9.log'],
    ['C:\\data\\name.'],
    ['C:\\data\\name '],
    ['C:\\data\\dir.\\file.txt'],
  ])('%s is refused on win32', (input) => {
    expect(checkName(input, 'win32')).toBe('reserved-name')
  })

  test.each<[input: string]>([
    ['C:\\data\\report.txt'],
    ['\\\\server\\share\\team\\plan.md'],
    ['C:\\data\\console.txt'],
    ['C:\\data\\.hidden'],
  ])('%s is accepted on win32', (input) => {
    expect(checkName(input, 'win32')).toBeNull()
  })

  test('the same names are ordinary on POSIX', () => {
    expect(checkName('/data/CON', 'linux')).toBeNull()
    expect(checkName('/data/report.txt:hidden', 'darwin')).toBeNull()
  })
})
