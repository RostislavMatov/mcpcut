import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { StoreCorruptError, createJsonStore } from '../../src/policy/store.js'
import { openSqlite } from '../../src/store/sqlite.js'

interface Counter {
  readonly count: number
  readonly tags?: readonly string[]
}

function validateCounter(raw: unknown): Counter {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as { count?: unknown }).count !== 'number'
  ) {
    throw new Error('expected an object with a numeric "count" field')
  }
  return raw as Counter
}

const defaultCounter: Counter = { count: 0 }

let tempDir: string
let filePath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-store-test-'))
  filePath = join(tempDir, 'nested', 'store.json')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('createJsonStore: read()', () => {
  test('returns a deep copy of the default value when the file does not exist', async () => {
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    const value = await store.read()
    expect(value).toEqual({ count: 0 })
    expect(value).not.toBe(defaultCounter)
  })

  test('rejects with StoreCorruptError on invalid JSON, without falling back to the default', async () => {
    await mkdir(join(tempDir, 'nested'), { recursive: true })
    await writeFile(filePath, '{not valid json', 'utf8')

    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    await expect(store.read()).rejects.toBeInstanceOf(StoreCorruptError)
  })

  test('rejects with StoreCorruptError when the parsed value fails validate()', async () => {
    await mkdir(join(tempDir, 'nested'), { recursive: true })
    await writeFile(filePath, JSON.stringify({ wrongShape: true }), 'utf8')

    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    await expect(store.read()).rejects.toBeInstanceOf(StoreCorruptError)
  })
})

describe('createJsonStore: update()', () => {
  test('persists the new value and resolves with it', async () => {
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    const result = await store.update((current) => ({ count: current.count + 1 }))
    expect(result).toEqual({ count: 1 })

    const rereadStore = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    expect(await rereadStore.read()).toEqual({ count: 1 })
  })

  test('never mutates the value it hands to fn, nor the value it returns after a later update', async () => {
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    const first = await store.update((current) => ({ ...current, count: current.count + 1 }))
    const second = await store.update((current) => ({ ...current, count: current.count + 1 }))

    expect(first).toEqual({ count: 1 })
    expect(second).toEqual({ count: 2 })
  })

  test('20 concurrent update() calls all land: no lost updates', async () => {
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    const concurrentUpdateCount = 20
    await Promise.all(
      Array.from({ length: concurrentUpdateCount }, () =>
        store.update((current) => ({ count: current.count + 1 })),
      ),
    )

    const finalValue = await store.read()
    expect(finalValue).toEqual({ count: concurrentUpdateCount })
  })

  test('rejects rather than silently overwriting when the existing file is corrupt', async () => {
    await mkdir(join(tempDir, 'nested'), { recursive: true })
    await writeFile(filePath, '{ this is not json', 'utf8')

    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    await expect(store.update((current) => ({ count: current.count + 1 }))).rejects.toBeInstanceOf(
      StoreCorruptError,
    )

    // The corrupt file must be left untouched, not silently replaced with a fresh default.
    const rawText = await readFile(filePath, 'utf8')
    expect(rawText).toBe('{ this is not json')
  })

  test('a rejected update does not wedge the queue for subsequent updates', async () => {
    await mkdir(join(tempDir, 'nested'), { recursive: true })
    await writeFile(filePath, '{ not json', 'utf8')

    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    await expect(store.update((current) => ({ count: current.count + 1 }))).rejects.toBeInstanceOf(
      StoreCorruptError,
    )

    // Fix the file out of band, then confirm the store still works.
    await writeFile(filePath, JSON.stringify({ count: 5 }), 'utf8')
    const result = await store.update((current) => ({ count: current.count + 1 }))
    expect(result).toEqual({ count: 6 })
  })
})

describe.skipIf(process.platform === 'win32')('createJsonStore: file permissions', () => {
  test('creates the parent directory with mode 0700 and the database with mode 0600', async () => {
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    await store.update((current) => ({ count: current.count + 1 }))

    const dirStat = await stat(join(tempDir, 'nested'))
    const dbStat = await stat(join(tempDir, 'nested', 'state.db'))

    expect(dirStat.mode & 0o777).toBe(0o700)
    expect(dbStat.mode & 0o777).toBe(0o600)
  })
})

/**
 * The store moved from "one JSON file per document" to a shared `state.db`
 * next to it. A legacy file left by an older build must still be honoured on
 * first touch (an operator who upgrades and runs `serve` before `migrate`
 * must not see an empty registry), and it must be imported without ever being
 * written back to or deleted — the file stays as a cold backup until wave 5.
 */
describe('createJsonStore: legacy JSON migration', () => {
  test('reads a pre-existing legacy file through the new store without losing values', async () => {
    await mkdir(join(tempDir, 'nested'), { recursive: true })
    await writeFile(filePath, JSON.stringify({ count: 7, tags: ['a', 'b'] }), 'utf8')

    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    expect(await store.read()).toEqual({ count: 7, tags: ['a', 'b'] })
  })

  test('an update lands in state.db and leaves the legacy file byte- and mtime-identical', async () => {
    await mkdir(join(tempDir, 'nested'), { recursive: true })
    const legacyText = JSON.stringify({ count: 5 })
    await writeFile(filePath, legacyText, 'utf8')
    const before = await stat(filePath)

    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    expect(await store.update((current) => ({ count: current.count + 1 }))).toEqual({ count: 6 })

    const after = await stat(filePath)
    expect(await readFile(filePath, 'utf8')).toBe(legacyText)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    // A fresh instance sees 6, not the 5 still sitting in the legacy file:
    // the value is served from state.db.
    const rereadStore = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    expect(await rereadStore.read()).toEqual({ count: 6 })
  })

  test('a corrupt legacy file is loud on read() and update(), and imports nothing', async () => {
    await mkdir(join(tempDir, 'nested'), { recursive: true })
    await writeFile(filePath, '{ not json at all', 'utf8')

    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    await expect(store.read()).rejects.toBeInstanceOf(StoreCorruptError)
    await expect(store.update((current) => ({ count: current.count + 1 }))).rejects.toBeInstanceOf(
      StoreCorruptError,
    )

    // Nothing was imported: repairing the file out of band makes its value
    // visible, which a garbage row in the database would have shadowed.
    await writeFile(filePath, JSON.stringify({ count: 9 }), 'utf8')
    const repairedStore = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    expect(await repairedStore.read()).toEqual({ count: 9 })
  })

  test('a row already in state.db wins over a newer legacy file', async () => {
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    await store.update(() => ({ count: 1 }))

    // A legacy file appearing (or being touched) afterwards is stale by
    // definition — the database is the authority once a row exists.
    await writeFile(filePath, JSON.stringify({ count: 99 }), 'utf8')

    const rereadStore = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    expect(await rereadStore.read()).toEqual({ count: 1 })
    expect(await rereadStore.update((current) => ({ count: current.count + 1 }))).toEqual({
      count: 2,
    })
  })

  test('two documents in one directory share state.db without colliding', async () => {
    const dir = join(tempDir, 'nested')
    await mkdir(dir, { recursive: true })
    const agentsPath = join(dir, 'agents.json')
    const registryPath = join(dir, 'registry.json')
    await writeFile(agentsPath, JSON.stringify({ count: 10 }), 'utf8')

    const agentsStore = createJsonStore<Counter>(agentsPath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    const registryStore = createJsonStore<Counter>(registryPath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    await agentsStore.update((current) => ({ count: current.count + 1 }))
    await registryStore.update((current) => ({ count: current.count + 100 }))

    expect(await agentsStore.read()).toEqual({ count: 11 })
    expect(await registryStore.read()).toEqual({ count: 100 })
    await expect(access(join(dir, 'state.db'))).resolves.toBeUndefined()
  })

  test('a state.db replaced on disk is noticed: the cached connection is retired, not trusted', async () => {
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    expect(await store.update(() => ({ count: 1 }))).toEqual({ count: 1 })

    // Simulate a backup restore / journal-dir reset out from under a running
    // process: the path now resolves to a different (here: absent) file. A
    // connection pinned to the unlinked old inode would keep serving state
    // the disk no longer holds.
    const dir = join(tempDir, 'nested')
    await rm(join(dir, 'state.db'), { force: true })
    await rm(join(dir, 'state.db-wal'), { force: true })
    await rm(join(dir, 'state.db-shm'), { force: true })

    expect(await store.read()).toEqual(defaultCounter)
  })

  test('a migrated document whose row vanished is refused, never re-imported from the stale file', async () => {
    await mkdir(join(tempDir, 'nested'), { recursive: true })
    await writeFile(filePath, JSON.stringify({ count: 3 }), 'utf8')

    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    expect(await store.read()).toEqual({ count: 3 })

    // Simulate the classic loss: state.db restored without the rows it held
    // (e.g. a backup that missed the -wal sidecar). The migration marker
    // survives; the document row does not.
    const raw = await openSqlite(join(tempDir, 'nested', 'state.db'), { synchronous: 'normal' })
    raw.db.exec('DELETE FROM documents')
    raw.close()

    // Silently re-importing the legacy file here would resurrect whatever it
    // held at migration time (revoked credentials included) as authoritative.
    const rereadStore = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    await expect(rereadStore.read()).rejects.toBeInstanceOf(StoreCorruptError)
    await expect(
      rereadStore.update((current) => ({ count: current.count + 1 })),
    ).rejects.toBeInstanceOf(StoreCorruptError)
  })
})
