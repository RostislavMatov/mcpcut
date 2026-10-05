import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { overlapsDataDir, rootsOutsideDataDir } from '../../src/files/data-overlap.js'
import { prepareRoot } from '../../src/files/roots-admin.js'

let base: string
let data: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-overlap-')))
  data = join(base, 'data')
  await mkdir(join(data, 'sub'), { recursive: true })
  await mkdir(join(base, 'data2'))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('overlapsDataDir', () => {
  test('the folder itself, a folder inside it and a folder holding it all overlap', () => {
    expect(overlapsDataDir('/home/u/.mcpcut', '/home/u/.mcpcut', 'linux')).toBe(true)
    expect(overlapsDataDir('/home/u/.mcpcut/data/x', '/home/u/.mcpcut/data', 'linux')).toBe(true)
    expect(overlapsDataDir('/home/u', '/home/u/.mcpcut/data', 'linux')).toBe(true)
    expect(overlapsDataDir('/', '/home/u/.mcpcut/data', 'linux')).toBe(true)
  })

  test('a sibling that shares a name prefix does not', () => {
    expect(overlapsDataDir('/home/u/.mcpcut2', '/home/u/.mcpcut', 'linux')).toBe(false)
    expect(overlapsDataDir('/srv/data', '/home/u/.mcpcut', 'linux')).toBe(false)
  })

  test('case is folded where the platform folds', () => {
    expect(overlapsDataDir('/Users/U/.MCPCUT', '/users/u/.mcpcut/data', 'darwin')).toBe(true)
    expect(overlapsDataDir('/Users/U/.MCPCUT', '/users/u/.mcpcut/data', 'linux')).toBe(false)
  })
})

describe('rootsOutsideDataDir', () => {
  test('drops the roots that overlap, keeps the others in order', async () => {
    const kept = await rootsOutsideDataDir([join(base, 'data2'), data, join(data, 'sub'), base], data)
    expect(kept).toEqual([join(base, 'data2')])
  })

  test('a link to the data folder is judged by where it leads', async () => {
    await symlink(data, join(base, 'link'))
    expect(await rootsOutsideDataDir([join(base, 'link')], data)).toEqual([])
  })
})

describe('prepareRoot and mcpcut data', () => {
  const refusal = (result: Awaited<ReturnType<typeof prepareRoot>>): string => (result.ok ? '' : result.message)

  test.each([
    ['the data folder', () => data],
    ['a folder inside it', () => join(data, 'sub')],
    ['a folder that holds it', () => base],
  ])('refuses %s with one line naming both paths', async (_name, pick) => {
    const result = await prepareRoot(pick(), [], undefined, data)

    expect(result.ok).toBe(false)
    expect(refusal(result)).toContain(data)
    expect(refusal(result)).toContain('outside it')
    expect(refusal(result)).not.toContain('\n')
  })

  test('accepts a sibling folder', async () => {
    expect((await prepareRoot(join(base, 'data2'), [], undefined, data)).ok).toBe(true)
  })

  test('refuses a link that leads into the data folder', async () => {
    await symlink(join(data, 'sub'), join(base, 'link'))
    expect((await prepareRoot(join(base, 'link'), [], undefined, data)).ok).toBe(false)
  })
})
