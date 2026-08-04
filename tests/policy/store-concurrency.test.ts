import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { StoreCorruptError, createJsonStore, type JsonStore } from '../../src/policy/store.js'

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
