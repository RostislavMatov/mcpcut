import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { TRASH_DIR_NAME } from '../../src/files/constants.js'
import { checkName, hasTrashSegment, isLexicallyUnder } from '../../src/files/names.js'
import { resolveWithinRoots, type PathResult } from '../../src/files/paths.js'

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
    expect(result.path).toMatchObject({
      root,
      absolute: join(root, 'Data', 'a.txt'),
      relative: join('Data', 'a.txt'),
      exists: true,
    })
    expect(result.path.chain[0]?.path).toBe(join(root, 'Data', 'a.txt'))
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

describe('resolveWithinRoots — review findings (03.10)', () => {
  test('a trash-like name is refused at any depth, so the trash of a nested root is unreachable from the outer one', async () => {
    await mkdir(join(root, 'proj', TRASH_DIR_NAME), { recursive: true })
    expectRefused(await resolveWithinRoots(join(root, 'proj', TRASH_DIR_NAME, 'x.txt'), [root]), 'trash')
  })

  test('a name the volume folds to the trash name (long s, U+017F) is refused before the trash exists', async () => {
    const fresh = join(base, 'fresh-fold')
    await mkdir(fresh, { recursive: true })
    expectRefused(await resolveWithinRoots(join(fresh, '.mcpcut-tra\u017fh', 'x.txt'), [fresh]), 'trash')
  })

  test('a symlink inside the root that points into the trash is refused by identity', async () => {
    await symlink(join(root, TRASH_DIR_NAME), join(root, 'to-trash'))
    expectRefused(await resolveWithinRoots(join(root, 'to-trash', 'old.txt'), [root]), 'trash')
  })

  test('a path nowhere near a root is refused without being resolved', async () => {
    expectRefused(await resolveWithinRoots(join(outside, 'secret.txt'), [root]), 'outside-roots')
  })

  test.runIf(process.platform === 'darwin')('an NFD spelling of an NFC folder resolves inside the same root', async () => {
    await mkdir(join(root, 'caf\u00e9'), { recursive: true })
    const result = await resolveWithinRoots(join(root, 'cafe\u0301', 'n.txt'), [root])
    expectOk(result)
    expect(result.path.root).toBe(root)
  })
})

describe('isLexicallyUnder — the gate before any file system call', () => {
  test('a UNC path to another host is not under a local root', () => {
    expect(isLexicallyUnder('\\\\attacker\\share\\x', ['C:\\data'], 'win32')).toBe(false)
  })

  test('letter case and Unicode form do not matter where volumes fold them', () => {
    expect(isLexicallyUnder('C:\\DATA\\x', ['C:\\data'], 'win32')).toBe(true)
    expect(isLexicallyUnder('/Data/cafe\u0301/x', ['/data/caf\u00e9'], 'darwin')).toBe(true)
  })

  test('on Linux they do — two spellings are two folders', () => {
    expect(isLexicallyUnder('/Data/x', ['/data'], 'linux')).toBe(false)
  })

  test('a sibling sharing the prefix is not under the root', () => {
    expect(isLexicallyUnder('/data-evil/x', ['/data'], 'linux')).toBe(false)
  })
})

describe('hasTrashSegment', () => {
  test.each<[input: string, expected: boolean]>([
    [`a/${TRASH_DIR_NAME}/b`, true],
    ['a/.MCPCUT-TRASH', true],
    ['a/.mcpcut-trash.', true],
    ['a/.mcpcut-tra\u017fh', true],
    ['a/mcpcut-trash', false],
    ['a/.mcpcut-trashes', false],
  ])('%s → %s', (input, expected) => {
    expect(hasTrashSegment(input)).toBe(expected)
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
    ['C:\\data\\CONIN$'],
    ['C:\\data\\conout$.txt'],
    ['C:\\data\\CLOCK$'],
    ['C:\\data\\NUL .txt'],
  ])('%s is refused on win32', (input) => {
    expect(checkName(input, 'win32')).toBe('reserved-name')
  })

  test.each<[input: string]>([['\\\\.\\pipe\\x'], ['\\\\?\\C:\\data\\x'], ['//./COM1'], ['\\\\.\\C:\\data']])(
    '%s is a device or extended path on win32',
    (input) => {
      expect(checkName(input, 'win32')).toBe('device-path')
    },
  )

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
