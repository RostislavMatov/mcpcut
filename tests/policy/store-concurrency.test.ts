import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { StoreCorruptError, createJsonStore, type JsonStore } from '../../src/policy/store.js'

/**
 * `rename` is wrapped so a single test (TS-LOW-1) can force it to fail
 * permanently without touching filesystem permissions (unreliable when tests
 * run as root) or racing real directory-vs-file conflicts. Every other test
 * in this file calls straight through to the real implementation.
 */
let failRenamePermanently = false

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: (...args: Parameters<typeof actual.rename>) => {
      if (failRenamePermanently) {
        return Promise.reject(
          Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' }),
        )
      }
      return actual.rename(...args)
    },
  }
})

interface CounterStore {
  readonly version: 1
  readonly items: Record<string, number>
}

const DEFAULT: CounterStore = { version: 1, items: {} }

function validate(raw: unknown): CounterStore {
  if (typeof raw !== 'object' || raw === null) throw new Error('bad store')
  const value = raw as Record<string, unknown>
  if (value['version'] !== 1 || typeof value['items'] !== 'object' || value['items'] === null) {
    throw new Error('bad store shape')
  }
  return { version: 1, items: value['items'] as Record<string, number> }
}

let dir: string
let filePath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-store-conc-'))
  filePath = join(dir, 'store.json')
})

afterEach(async () => {
  failRenamePermanently = false
  await rm(dir, { recursive: true, force: true })
})

function open(): JsonStore<CounterStore> {
  return createJsonStore<CounterStore>(filePath, { validate, defaultValue: DEFAULT })
}

describe('H5/TS-H2: concurrent stores do not lose writes', () => {
  test('two instances racing on one file both land their writes', async () => {
    const a = open()
    const b = open()

    await Promise.all([
      a.update((s) => ({ ...s, items: { ...s.items, a: 1 } })),
      b.update((s) => ({ ...s, items: { ...s.items, b: 2 } })),
    ])

    const final = await open().read()
    expect(final.items).toEqual({ a: 1, b: 2 })
  })

  test('three instances issuing many concurrent updates lose nothing and never throw ENOENT', async () => {
    const stores = [open(), open(), open()]
    const perStore = 15

    const writes = stores.flatMap((store, s) =>
      Array.from({ length: perStore }, (_, i) =>
        store.update((cur) => ({ ...cur, items: { ...cur.items, [`s${s}_i${i}`]: s * 100 + i } })),
      ),
    )

    await expect(Promise.all(writes)).resolves.toBeDefined()

    const final = await open().read()
    expect(Object.keys(final.items)).toHaveLength(stores.length * perStore)
  })
})

describe('H5: a corrupt store is loud, never silently empty', () => {
  test('read() on unparseable JSON rejects with StoreCorruptError', async () => {
    await writeFile(filePath, '{ not valid', 'utf8')
    await expect(open().read()).rejects.toBeInstanceOf(StoreCorruptError)
  })

  test('update() on a corrupt store rejects rather than overwriting with a default', async () => {
    await writeFile(filePath, 'garbage', 'utf8')
    await expect(open().update((s) => s)).rejects.toBeInstanceOf(StoreCorruptError)
  })
})

describe('TS-MEDIUM: a stale lock steal verifies ownership (no double-steal, no lost update)', () => {
  async function seedStaleLock(): Promise<void> {
    await mkdir(dir, { recursive: true })
    // A lock recorded as created 60s ago (well past the staleness window),
    // as a previous holder that crashed mid-update would have left behind.
    await writeFile(
      `${filePath}.lock`,
      JSON.stringify({ pid: 999_999, createdAtMs: Date.now() - 60_000 }),
      'utf8',
    )
  }

  test('two instances racing a stale lock both land their writes: exactly one steals, none is lost', async () => {
    await seedStaleLock()
    const a = open()
    const b = open()

    await Promise.all([
      a.update((s) => ({ ...s, items: { ...s.items, a: 1 } })),
      b.update((s) => ({ ...s, items: { ...s.items, b: 2 } })),
    ])

    const final = await open().read()
    expect(final.items).toEqual({ a: 1, b: 2 })
  })

  test('the stale lock is gone afterward: no orphaned lockfile survives the steal', async () => {
    await seedStaleLock()
    await open().update((s) => ({ ...s, items: { ...s.items, x: 1 } }))

    const entries = await readdir(dir)
    expect(entries.filter((name) => name.endsWith('.lock'))).toEqual([])
  })
})

describe('TS-LOW-1: writeAtomic never leaks its .tmp file on a permanent rename failure', () => {
  test('a permanently failing rename leaves no .tmp file behind', async () => {
    failRenamePermanently = true
    const store = open()

    await expect(store.update((s) => s)).rejects.toThrow(/EACCES/)

    const leftover = (await readdir(dir)).filter((name) => name.endsWith('.tmp'))
    expect(leftover).toEqual([])
  })
})
