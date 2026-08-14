import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { openSqlite } from '../../src/store/sqlite.js'
import { StoreCorruptError, StoreLockError, createJsonStore, type JsonStore } from '../../src/policy/store.js'

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

/** Same store with a short busy timeout, for the contended write path. */
function openImpatient(): JsonStore<CounterStore> {
  return createJsonStore<CounterStore>(filePath, {
    validate,
    defaultValue: DEFAULT,
    lock: { totalWaitMs: 150 },
  })
}

describe('concurrent stores do not lose writes', () => {
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

describe('a corrupt store is loud, never silently empty', () => {
  test('read() on unparseable JSON rejects with StoreCorruptError', async () => {
    await writeFile(filePath, '{ not valid', 'utf8')
    await expect(open().read()).rejects.toBeInstanceOf(StoreCorruptError)
  })

  test('update() on a corrupt store rejects rather than overwriting with a default', async () => {
    await writeFile(filePath, 'garbage', 'utf8')
    await expect(open().update((s) => s)).rejects.toBeInstanceOf(StoreCorruptError)
  })
})

describe('a writer lock held past the busy timeout surfaces StoreLockError', () => {
  test('update() rejects with StoreLockError and the stored value stays unchanged', async () => {
    // Arrange: seed a known value, then take the write lock on the same
    // state.db from a second, raw connection and hold it open across awaits
    // (handle.transaction() commits synchronously, so it cannot model a
    // lock held for the duration of an assertion — a direct BEGIN IMMEDIATE
    // on the raw handle can).
    const seeded = await open().update((s) => ({ ...s, items: { seed: 1 } }))
    expect(seeded.items).toEqual({ seed: 1 })

    const dbPath = join(dir, 'state.db')
    const holder = await openSqlite(dbPath, { synchronous: 'normal' })
    holder.db.exec('BEGIN IMMEDIATE')

    let caughtError: unknown
    try {
      // Act
      await openImpatient().update((s) => ({ ...s, items: { ...s.items, blocked: 1 } }))
    } catch (error: unknown) {
      caughtError = error
    } finally {
      holder.db.exec('ROLLBACK')
      holder.close()
    }

    // Assert: a StoreLockError specifically, not some other/generic Error.
    expect(caughtError).toBeInstanceOf(StoreLockError)
    expect((caughtError as Error).constructor).toBe(StoreLockError)

    const final = await open().read()
    expect(final.items).toEqual({ seed: 1 })
  })

  test('a first-ever write of a new document lands even after the pessimistic threshold was crossed', async () => {
    // Arrange: the database exists but the target document has NO row yet.
    // A raw holder keeps the write lock long enough that the writer racks up
    // more busy losses than the pessimistic threshold, then releases. Row
    // creation belongs to the optimistic path — if crossing the threshold
    // ever locked the writer into pessimistic-only attempts, this first
    // write would spin to its deadline instead of landing.
    await open().read()
    const dbPath = join(dir, 'state.db')
    const holder = await openSqlite(dbPath, { synchronous: 'normal' })
    holder.db.exec('BEGIN IMMEDIATE')
    const releaseHolder = sleep(500).then(() => {
      holder.db.exec('ROLLBACK')
      holder.close()
    })

    const freshStore = createJsonStore<CounterStore>(join(dir, 'fresh.json'), {
      validate,
      defaultValue: DEFAULT,
      lock: { totalWaitMs: 5_000 },
    })

    try {
      // Act
      const committed = await freshStore.update((s) => ({ ...s, items: { first: 1 } }))

      // Assert
      expect(committed.items).toEqual({ first: 1 })
      const reread = await createJsonStore<CounterStore>(join(dir, 'fresh.json'), {
        validate,
        defaultValue: DEFAULT,
      }).read()
      expect(reread.items).toEqual({ first: 1 })
    } finally {
      await releaseHolder
    }
  })
})
