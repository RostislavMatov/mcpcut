import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { StoreCorruptError, StoreWriteRejectedError, createJsonStore } from '../../src/policy/store.js'
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
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-store-test-'))
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

describe('createJsonStore: write-time validation', () => {
  test('refuses a value the validator rejects and leaves the document unchanged', async () => {
    // Arrange
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    await store.update(() => ({ count: 1 }))

    // Act
    const refused = store.update(() => ({ nope: true }) as unknown as Counter)

    // Assert — the refusal is an expected boundary error, never corruption,
    // and the document a later read sees is the one that was already there.
    await expect(refused).rejects.toBeInstanceOf(StoreWriteRejectedError)
    await expect(refused).rejects.not.toBeInstanceOf(StoreCorruptError)
    expect(await store.read()).toEqual({ count: 1 })
  })

  test('a refused first-ever write leaves no row behind', async () => {
    // Arrange
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    // Act
    const refused = store.update(() => ({ nope: true }) as unknown as Counter)

    // Assert
    await expect(refused).rejects.toBeInstanceOf(StoreWriteRejectedError)
    expect(await store.read()).toEqual(defaultCounter)
  })

  test('names the document path so the operator knows which store refused', async () => {
    // Arrange
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    // Act
    const refused = store.update(() => ({ nope: true }) as unknown as Counter)

    // Assert
    await expect(refused).rejects.toThrow(filePath)
  })

  test('a valid write still lands after a refused one', async () => {
    // Arrange
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    await expect(
      store.update(() => ({ nope: true }) as unknown as Counter),
    ).rejects.toBeInstanceOf(StoreWriteRejectedError)

    // Act
    const value = await store.update((current) => ({ count: current.count + 5 }))

    // Assert
    expect(value).toEqual({ count: 5 })
    expect(await store.read()).toEqual({ count: 5 })
  })
})

describe('createJsonStore: rev-keyed read memo', () => {
  /** A validator that counts how often it ran, to observe the memo. */
  function countingValidate(): { validate: (raw: unknown) => Counter; count: () => number } {
    let calls = 0
    return {
      validate: (raw: unknown) => {
        calls += 1
        return validateCounter(raw)
      },
      count: () => calls,
    }
  }

  test('a second read of an unchanged row reuses the parsed value', async () => {
    // Arrange
    const spy = countingValidate()
    const store = createJsonStore<Counter>(filePath, {
      validate: spy.validate,
      defaultValue: defaultCounter,
    })
    await store.update(() => ({ count: 1 }))
    const before = spy.count()

    // Act
    const first = await store.read()
    const second = await store.read()

    // Assert — `groups.json` is read on every authentication; re-running zod
    // for a row that did not move is pure overhead.
    expect(spy.count()).toBe(before + 1)
    expect(second).toEqual({ count: 1 })
    // Still a value nobody else holds: the memo caches the PARSE, and each
    // read hands out its own copy, so a caller that mutates what it read
    // cannot poison the next reader.
    expect(second).not.toBe(first)
  })

  test('a write by another store instance on the same path is seen', async () => {
    // Arrange
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    await store.update(() => ({ count: 1 }))
    expect(await store.read()).toEqual({ count: 1 })

    // Act — a second process, modelled as a second store over the same file.
    const other = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    await other.update(() => ({ count: 9 }))

    // Assert
    expect(await store.read()).toEqual({ count: 9 })
  })

  test("the store's own write invalidates the memo", async () => {
    // Arrange
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    await store.update(() => ({ count: 1 }))
    expect(await store.read()).toEqual({ count: 1 })

    // Act
    await store.update((current) => ({ count: current.count + 1 }))

    // Assert
    expect(await store.read()).toEqual({ count: 2 })
  })

  test('mutating a memoised read does not affect what the next read sees', async () => {
    // Arrange
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    await store.update(() => ({ count: 1 }))

    // Act
    const first = (await store.read()) as { count: number }
    first.count = 99

    // Assert
    expect(await store.read()).toEqual({ count: 1 })
  })

  test('a refused write does not poison the memo', async () => {
    // Arrange
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    await store.update(() => ({ count: 1 }))
    expect(await store.read()).toEqual({ count: 1 })

    // Act
    await expect(
      store.update(() => ({ nope: true }) as unknown as Counter),
    ).rejects.toBeInstanceOf(StoreWriteRejectedError)

    // Assert
    expect(await store.read()).toEqual({ count: 1 })
  })
})

describe('createJsonStore: prototype shape survives the read boundary', () => {
  /** A map the way the inventory validator builds one: null-prototype, so a hostile key is inert. */
  interface ProtoDoc {
    readonly version: 1
    readonly entries: Record<string, string>
  }

  function validateProtoDoc(raw: unknown): ProtoDoc {
    if (typeof raw !== 'object' || raw === null || (raw as { version?: unknown }).version !== 1) {
      throw new Error('expected an object with version 1')
    }
    const entriesRaw = (raw as { entries?: unknown }).entries
    const entries = Object.create(null) as Record<string, string>
    if (typeof entriesRaw === 'object' && entriesRaw !== null) {
      for (const [key, value] of Object.entries(entriesRaw)) {
        if (typeof value === 'string') {
          Object.defineProperty(entries, key, {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          })
        }
      }
    }
    return { version: 1, entries }
  }

  const defaultProtoDoc: ProtoDoc = { version: 1, entries: Object.create(null) as Record<string, string> }

  function protoStore(): ReturnType<typeof createJsonStore<ProtoDoc>> {
    return createJsonStore<ProtoDoc>(filePath, {
      validate: validateProtoDoc,
      defaultValue: defaultProtoDoc,
    })
  }

  test('the default value keeps its null-prototype maps', async () => {
    // Act
    const value = await protoStore().read()

    // Assert
    expect(Object.getPrototypeOf(value.entries)).toBeNull()
    expect(value.entries).not.toBe(defaultProtoDoc.entries)
  })

  test('a first read hands out the null-prototype map the validator built', async () => {
    // Arrange
    const store = protoStore()
    await store.update((current) => ({ ...current, entries: { real: 'yes' } }))

    // Act
    const value = await store.read()

    // Assert
    expect(Object.getPrototypeOf(value.entries)).toBeNull()
    expect(value.entries['toString']).toBeUndefined()
  })

  test('null-prototype maps survive a memo-hit read', async () => {
    // Arrange — the second read is served by the rev-keyed memo, which used to
    // hand out a `structuredClone`: that converts a null-prototype map into an
    // ordinary object, so `entries[name]` starts resolving through
    // `Object.prototype` again for a hostile key.
    const store = protoStore()
    await store.update((current) => ({ ...current, entries: { real: 'yes' } }))
    await store.read()

    // Act
    const second = await store.read()

    // Assert
    expect(Object.getPrototypeOf(second.entries)).toBeNull()
    expect(second.entries['constructor']).toBeUndefined()
    expect(second.entries['toString']).toBeUndefined()
    expect(second.entries['real']).toBe('yes')
  })

  test('a reserved-named entry round-trips as an ordinary own key on both reads', async () => {
    // Arrange
    const store = protoStore()
    await store.update((current) => ({
      ...current,
      entries: Object.assign(Object.create(null) as Record<string, string>, { constructor: 'mine' }),
    }))

    // Act
    const first = await store.read()
    const second = await store.read()

    // Assert
    expect(first.entries['constructor']).toBe('mine')
    expect(second.entries['constructor']).toBe('mine')
    expect(Object.hasOwn(second.entries, 'constructor')).toBe(true)
  })

  test('a memoised read is still a value nobody else holds', async () => {
    // Arrange
    const store = protoStore()
    await store.update((current) => ({ ...current, entries: { real: 'yes' } }))

    // Act
    const first = await store.read()
    ;(first.entries as Record<string, string>)['real'] = 'tampered'
    const second = await store.read()

    // Assert
    expect(second.entries['real']).toBe('yes')
    expect(second.entries).not.toBe(first.entries)
  })
})

describe('createJsonStore: an update that changes nothing writes nothing', () => {
  /** Every `documents` row in the store's database, as `name -> rev`. */
  async function documentRows(): Promise<Record<string, number>> {
    const raw = await openSqlite(join(tempDir, 'nested', 'state.db'), { synchronous: 'normal' })
    try {
      const rows = raw.db
        .prepare('SELECT name, rev FROM documents')
        .all() as Array<{ name: string; rev: number }>
      return Object.fromEntries(rows.map((row) => [row.name, row.rev]))
    } finally {
      raw.close()
    }
  }

  test('a callback returning its argument does not bump the revision', async () => {
    // Arrange
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    await store.update(() => ({ count: 1 }))
    const before = await documentRows()

    // Act
    const value = await store.update((current) => current)

    // Assert — a no-op refusal (an unknown name to remove, an idempotent
    // membership edit) must not look like an edit to the next CAS.
    expect(value).toEqual({ count: 1 })
    expect(await documentRows()).toEqual(before)
  })

  test('a no-op on a fresh install creates no row at all', async () => {
    // Arrange
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    // Act
    const value = await store.update((current) => current)

    // Assert
    expect(value).toEqual({ count: 0 })
    expect(await documentRows()).toEqual({})
  })

  test('the no-op value is still a copy nobody else holds', async () => {
    // Arrange
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    await store.update(() => ({ count: 1 }))

    // Act
    const value = (await store.update((current) => current)) as { count: number }
    value.count = 99

    // Assert
    expect(await store.read()).toEqual({ count: 1 })
  })

  test('a real change after a no-op still commits', async () => {
    // Arrange
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })
    await store.update((current) => current)

    // Act
    await store.update(() => ({ count: 7 }))

    // Assert
    expect(await store.read()).toEqual({ count: 7 })
    expect(Object.values(await documentRows())).toEqual([1])
  })

  test('a legacy file is still imported by a no-op update', async () => {
    // Arrange — the import is a real state transition (it writes the migration
    // marker), so the short-circuit must not skip it.
    await mkdir(join(tempDir, 'nested'), { recursive: true })
    await writeFile(filePath, JSON.stringify({ count: 42 }), 'utf8')
    const store = createJsonStore<Counter>(filePath, {
      validate: validateCounter,
      defaultValue: defaultCounter,
    })

    // Act
    const value = await store.update((current) => current)

    // Assert
    expect(value).toEqual({ count: 42 })
    expect(await documentRows()).toEqual({ 'store.json': 1 })
  })
})
