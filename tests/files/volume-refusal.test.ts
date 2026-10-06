import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { TRASH_DIR_NAME } from '../../src/files/constants.js'
import { statIdentity } from '../../src/files/identity.js'
import { resolveWithinRoots } from '../../src/files/paths.js'
import { prepareRoot } from '../../src/files/roots-admin.js'
import type { VolumeKind } from '../../src/files/volume.js'

/**
 * A network or FUSE drive may invent file identities (macOS smbfs: one inode
 * per Unicode spelling of a name), so a carved-out folder there is reachable
 * through its other spelling. Nothing on such a volume reaches an agent, and
 * such a folder is never declared as a root.
 */

let base: string
let root: string
let share: string

const networkUnder = (prefix: string) => async (canonical: string): Promise<VolumeKind> =>
  canonical === prefix || canonical.startsWith(`${prefix}/`) || canonical.startsWith(`${prefix}\\`) ? { kind: 'network', fsType: 'smbfs' } : { kind: 'local' }

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-files-volume-')))
  root = join(base, 'root')
  share = join(root, 'share')
  await mkdir(join(share, 'private'), { recursive: true })
  await mkdir(join(root, TRASH_DIR_NAME), { recursive: true })
  await writeFile(join(root, 'local.txt'), 'l')
  await writeFile(join(share, 'private', 'x.txt'), 'x')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('resolveWithinRoots on a network volume', () => {
  test('a file on a network drive mounted inside a local root is refused with the reason', async () => {
    const result = await resolveWithinRoots(join(share, 'private', 'x.txt'), [root], statIdentity, networkUnder(share))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal).toBe('unresolvable')
    expect(result.message).toMatch(/network or FUSE drive \(smbfs\)/)
    expect(result.message).toMatch(/ask an administrator/)
  })

  test('a file not created yet is judged by the volume it would land on', async () => {
    const result = await resolveWithinRoots(join(share, 'new-folder', 'new.txt'), [root], statIdentity, networkUnder(share))

    expect(result.ok).toBe(false)
  })

  test('a file on the local part of the root still resolves', async () => {
    const result = await resolveWithinRoots(join(root, 'local.txt'), [root], statIdentity, networkUnder(share))

    expect(result.ok).toBe(true)
  })

  test('a root that is itself on a network drive serves nothing', async () => {
    const result = await resolveWithinRoots(join(root, 'local.txt'), [root], statIdentity, networkUnder(root))

    expect(result.ok).toBe(false)
  })
})

describe('prepareRoot on a network volume', () => {
  test('refuses the folder in one line and creates no trash there', async () => {
    const result = await prepareRoot(share, [], statIdentity, undefined, networkUnder(share))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe(`${share} is on a network or FUSE drive (smbfs), where mcpcut cannot tell folders apart reliably: choose a folder on a local disk`)
    await expect(stat(join(share, TRASH_DIR_NAME))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a local folder is declared as before', async () => {
    const fresh = join(base, 'fresh')
    await mkdir(fresh)
    const result = await prepareRoot(fresh, [], statIdentity, undefined, networkUnder(share))

    expect(result.ok).toBe(true)
  })
})
