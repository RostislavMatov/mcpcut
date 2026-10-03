import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { MAX_PATH_LENGTH, MAX_ROOTS } from '../../src/files/constants.js'
import { RootsLimitError, createRootsStore, parseRootsFile } from '../../src/files/roots-store.js'

let journalDir: string
const clock = (): Date => new Date('2026-10-03T10:00:00.000Z')

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-roots-store-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

describe('roots store', () => {
  test('lists nothing on a fresh install', async () => {
    const store = createRootsStore({ journalDir })

    expect(await store.list()).toEqual([])
  })

  test('add persists the root with its timestamp and survives a new store instance', async () => {
    await createRootsStore({ journalDir, clock }).add('/data/a')

    const roots = await createRootsStore({ journalDir }).list()

    expect(roots).toEqual([{ path: '/data/a', addedAt: '2026-10-03T10:00:00.000Z' }])
  })

  test('add of an existing path is a no-op reporting added=false', async () => {
    const store = createRootsStore({ journalDir, clock })
    await store.add('/data/a')

    const result = await store.add('/data/a')

    expect(result.added).toBe(false)
    expect(await store.list()).toHaveLength(1)
  })

  test('list is sorted by path', async () => {
    const store = createRootsStore({ journalDir, clock })
    await store.add('/data/b')
    await store.add('/data/a')

    expect((await store.list()).map((root) => root.path)).toEqual(['/data/a', '/data/b'])
  })

  test('remove drops the root and reports whether it was there', async () => {
    const store = createRootsStore({ journalDir, clock })
    await store.add('/data/a')

    expect((await store.remove('/data/a')).removed).toBe(true)
    expect((await store.remove('/data/a')).removed).toBe(false)
    expect(await store.list()).toEqual([])
  })

  test('refuses a relative path, a NUL byte and an over-long path', async () => {
    const store = createRootsStore({ journalDir, clock })

    await expect(store.add('relative/dir')).rejects.toThrow()
    await expect(store.add('/data/\u0000x')).rejects.toThrow()
    await expect(store.add(`/${'a'.repeat(MAX_PATH_LENGTH)}`)).rejects.toThrow()
    expect(await store.list()).toEqual([])
  })

  test('refuses the root after MAX_ROOTS with a one-line error', async () => {
    const store = createRootsStore({ journalDir, clock })
    for (let index = 0; index < MAX_ROOTS; index += 1) await store.add(`/data/r${index}`)

    await expect(store.add('/data/one-more')).rejects.toBeInstanceOf(RootsLimitError)
    await expect(store.add('/data/one-more')).rejects.toThrow(/at most 50 roots.*files root remove/)
  })

  test('returned lists are not shared state', async () => {
    const store = createRootsStore({ journalDir, clock })
    await store.add('/data/a')
    const first = (await store.list()) as { path: string }[]

    first.pop()

    expect(await store.list()).toHaveLength(1)
  })
})

describe('roots file schema', () => {
  const valid = { version: 1, roots: [{ path: '/a', addedAt: '2026-10-03T10:00:00.000Z' }] }

  test('accepts a valid document', () => {
    expect(parseRootsFile(valid).ok).toBe(true)
  })

  test.each([
    ['unknown top-level key', { ...valid, extra: 1 }],
    ['unknown root key', { version: 1, roots: [{ ...valid.roots[0], extra: 1 }] }],
    ['wrong version', { ...valid, version: 2 }],
    ['duplicate paths', { version: 1, roots: [valid.roots[0], valid.roots[0]] }],
    ['bad date', { version: 1, roots: [{ path: '/a', addedAt: 'yesterday' }] }],
    ['null', null],
  ])('rejects %s', (_label, raw) => {
    expect(parseRootsFile(raw).ok).toBe(false)
  })

  test('rejects more than MAX_ROOTS roots', () => {
    const roots = Array.from({ length: MAX_ROOTS + 1 }, (_, index) => ({
      path: `/r${index}`,
      addedAt: '2026-10-03T10:00:00.000Z',
    }))

    expect(parseRootsFile({ version: 1, roots }).ok).toBe(false)
  })
})
