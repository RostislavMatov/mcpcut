import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { StoreCorruptError, createJsonStore } from '../../src/policy/store.js'

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

  test('20 concurrent update() calls all land: no lost updates, file parses cleanly at the end', async () => {
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

    const rawText = await readFile(filePath, 'utf8')
    expect(() => JSON.parse(rawText)).not.toThrow()
  })

  test('does not leave a .tmp file behind after a successful update', async () => {
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    await store.update((current) => ({ count: current.count + 1 }))

    await expect(access(`${filePath}.tmp`)).rejects.toThrow()
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
  test('creates the parent directory with mode 0700 and the file with mode 0600', async () => {
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    await store.update((current) => ({ count: current.count + 1 }))

    const dirStat = await stat(join(tempDir, 'nested'))
    const fileStat = await stat(filePath)

    expect(dirStat.mode & 0o777).toBe(0o700)
    expect(fileStat.mode & 0o777).toBe(0o600)
  })
})
