import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { TRASH_DIR_NAME } from '../../src/files/constants.js'
import { statIdentity, type StatFn } from '../../src/files/identity.js'
import { resolveWithinRoots } from '../../src/files/paths.js'
import { prepareRoot } from '../../src/files/roots-admin.js'

/** Security review M3: a file system whose identities are not reliable must fail closed. */

let base: string
let root: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-ident-')))
  root = join(base, 'r')
  await mkdir(join(root, 'sub'), { recursive: true })
  await mkdir(join(root, TRASH_DIR_NAME))
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

/** The real stat, except that the named paths report what a bad mount would. */
function faking(overrides: Readonly<Record<string, { dev?: bigint; ino: bigint }>>): StatFn {
  return async (target) => {
    const real = await statIdentity(target)
    const fake = overrides[target]
    return real === null || fake === undefined ? real : { ...real, dev: fake.dev ?? real.dev, ino: fake.ino }
  }
}

describe('resolveWithinRoots with unreliable identities', () => {
  test('refuses a chain entry with inode 0 and says identities are not reliable', async () => {
    const result = await resolveWithinRoots(join(root, 'sub', 'f.txt'), [root], faking({ [join(root, 'sub')]: { ino: 0n } }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal).toBe('unresolvable')
    expect(result.message).toContain('file identities are not reliable on this file system')
  })

  test('refuses two different folders in the chain that report one identity', async () => {
    const same = { dev: 1n, ino: 77n }
    const result = await resolveWithinRoots(join(root, 'sub', 'f.txt'), [root], faking({ [join(root, 'sub')]: same, [root]: same }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal).toBe('unresolvable')
  })

  test('still resolves with the real identities', async () => {
    expect((await resolveWithinRoots(join(root, 'sub', 'f.txt'), [root])).ok).toBe(true)
  })

  test('a root whose identity equals its trash is skipped (fail closed)', async () => {
    const same = { dev: 1n, ino: 5n }
    const result = await resolveWithinRoots(join(root, 'sub'), [root], faking({ [root]: same, [join(root, TRASH_DIR_NAME)]: same }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal).toBe('outside-roots')
  })

  test('a root with inode 0 is skipped', async () => {
    const result = await resolveWithinRoots(join(root, 'sub'), [root], faking({ [root]: { ino: 0n } }))
    expect(result.ok).toBe(false)
  })

  test('a trash with inode 0 skips the root', async () => {
    const result = await resolveWithinRoots(join(root, 'sub'), [root], faking({ [join(root, TRASH_DIR_NAME)]: { ino: 0n } }))
    expect(result.ok).toBe(false)
  })
})

describe('prepareRoot with unreliable identities', () => {
  const NOT_STABLE = /does not report stable file identities.*cannot be shared safely/

  test('refuses a folder whose identity equals its trash and removes the trash it made', async () => {
    const dir = join(base, 'fresh')
    await mkdir(dir)
    const same = { dev: 1n, ino: 5n }
    const result = await prepareRoot(dir, [], faking({ [dir]: same, [join(dir, TRASH_DIR_NAME)]: same }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toMatch(NOT_STABLE)
    expect(result.message).not.toContain('\n')
    expect(await statIdentity(join(dir, TRASH_DIR_NAME))).toBeNull()
  })

  test('refuses a folder with inode 0', async () => {
    const dir = join(base, 'zero')
    await mkdir(dir)
    const result = await prepareRoot(dir, [], faking({ [dir]: { ino: 0n } }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(NOT_STABLE)
  })

  test('refuses a trash with inode 0', async () => {
    const dir = join(base, 'ztrash')
    await mkdir(dir)
    const result = await prepareRoot(dir, [], faking({ [join(dir, TRASH_DIR_NAME)]: { ino: 0n } }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(NOT_STABLE)
  })
})
