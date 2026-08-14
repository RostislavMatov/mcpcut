import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  SqliteBusyError,
  SqliteOpenError,
  openSqlite,
  type SqliteHandle,
} from '../../src/store/sqlite.js'

let tempDir: string
let dbPath: string
const handles: SqliteHandle[] = []

/** Tracks handles so a failing test never leaks an open database. */
async function open(...args: Parameters<typeof openSqlite>): Promise<SqliteHandle> {
  const handle = await openSqlite(...args)
  handles.push(handle)
  return handle
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-sqlite-test-'))
  dbPath = join(tempDir, 'nested', 'state.db')
})

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    handle.close()
  }
  await rm(tempDir, { recursive: true, force: true })
})

function pragmaValue(handle: SqliteHandle, pragma: string): unknown {
  const row = handle.db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>
  return Object.values(row)[0]
}

describe('openSqlite: opening and permissions', () => {
  test('creates the parent directory (0700) and database file (0600)', async () => {
    await open(dbPath, { synchronous: 'normal' })

    const dirStat = await stat(join(tempDir, 'nested'))
    const fileStat = await stat(dbPath)
    expect(dirStat.mode & 0o777).toBe(0o700)
    expect(fileStat.mode & 0o777).toBe(0o600)
  })

  test('tightens permissions of a pre-existing directory and file back to 0700/0600', async () => {
    const dir = join(tempDir, 'nested')
    await mkdir(dir, { recursive: true, mode: 0o755 })
    const first = await open(dbPath, { synchronous: 'normal' })
    first.close()
    await chmod(dir, 0o755)
    await chmod(dbPath, 0o644)

    await open(dbPath, { synchronous: 'normal' })

    const dirStat = await stat(dir)
    const fileStat = await stat(dbPath)
    expect(dirStat.mode & 0o777).toBe(0o700)
    expect(fileStat.mode & 0o777).toBe(0o600)
  })

  test('the -wal side file inherits the 0600 mode of the database file', async () => {
    const handle = await open(dbPath, { synchronous: 'normal' })
    handle.db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    handle.transaction((db) => {
      db.prepare('INSERT INTO items (id) VALUES (1)').run()
    })

    const walStat = await stat(`${dbPath}-wal`)
    expect(walStat.mode & 0o777).toBe(0o600)
  })

  test('the -shm side file inherits the 0600 mode of the database file', async () => {
    const handle = await open(dbPath, { synchronous: 'normal' })
    handle.db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    handle.transaction((db) => {
      db.prepare('INSERT INTO items (id) VALUES (1)').run()
    })

    // -shm is only created on demand by WAL mode; skip if this SQLite build
    // didn't materialize it rather than asserting on a file that may not exist.
    const shmStat = await stat(`${dbPath}-shm`).catch(() => null)
    if (shmStat === null) return
    expect(shmStat.mode & 0o777).toBe(0o600)
  })

  test('exposes the path it was opened with', async () => {
    const handle = await open(dbPath, { synchronous: 'normal' })
    expect(handle.filePath).toBe(dbPath)
  })

  test('rejects with SqliteOpenError when the file is not a database', async () => {
    await mkdir(join(tempDir, 'nested'), { recursive: true })
    await writeFile(dbPath, 'this is not a sqlite file, and long enough to have a header', 'utf8')

    const handle = await openSqlite(dbPath, { synchronous: 'normal' }).catch((e: unknown) => e)
    expect(handle).toBeInstanceOf(SqliteOpenError)
  })

  test('rejects a non-integer or negative busyTimeoutMs', async () => {
    await expect(
      openSqlite(dbPath, { synchronous: 'normal', busyTimeoutMs: -1 }),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      openSqlite(dbPath, { synchronous: 'normal', busyTimeoutMs: 1.5 }),
    ).rejects.toBeInstanceOf(TypeError)
  })
})

describe('openSqlite: PRAGMA set (ADR-0006)', () => {
  test('enables WAL journal mode', async () => {
    const handle = await open(dbPath, { synchronous: 'normal' })
    expect(pragmaValue(handle, 'journal_mode')).toBe('wal')
  })

  test("synchronous: 'normal' maps to NORMAL (1)", async () => {
    const handle = await open(dbPath, { synchronous: 'normal' })
    expect(pragmaValue(handle, 'synchronous')).toBe(1)
  })

  test("synchronous: 'full' maps to FULL (2)", async () => {
    const handle = await open(dbPath, { synchronous: 'full' })
    expect(pragmaValue(handle, 'synchronous')).toBe(2)
  })

  test('enables foreign key enforcement', async () => {
    const handle = await open(dbPath, { synchronous: 'normal' })
    expect(pragmaValue(handle, 'foreign_keys')).toBe(1)
  })

  test('sets the default busy timeout', async () => {
    const handle = await open(dbPath, { synchronous: 'normal' })
    expect(pragmaValue(handle, 'busy_timeout')).toBe(5000)
  })

  test('honours a caller-provided busy timeout', async () => {
    const handle = await open(dbPath, { synchronous: 'normal', busyTimeoutMs: 25 })
    expect(pragmaValue(handle, 'busy_timeout')).toBe(25)
  })
})

describe('transaction()', () => {
  test('commits the work and returns the callback value', async () => {
    const handle = await open(dbPath, { synchronous: 'normal' })
    handle.db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')

    const result = handle.transaction((db) => {
      db.prepare('INSERT INTO items (name) VALUES (?)').run('alpha')
      return 'done'
    })

    expect(result).toBe('done')
    const row = handle.db.prepare('SELECT name FROM items WHERE id = 1').get()
    expect(row).toMatchObject({ name: 'alpha' })
  })

  test('rolls back everything when the callback throws, and rethrows', async () => {
    const handle = await open(dbPath, { synchronous: 'normal' })
    handle.db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')

    expect(() =>
      handle.transaction((db) => {
        db.prepare('INSERT INTO items (name) VALUES (?)').run('doomed')
        throw new Error('boom')
      }),
    ).toThrow('boom')

    const row = handle.db.prepare('SELECT COUNT(*) AS n FROM items').get()
    expect(row).toMatchObject({ n: 0 })
  })

  test('a failing ROLLBACK does not mask the original error', async () => {
    const handle = await open(dbPath, { synchronous: 'normal' })

    // The callback commits the transaction itself and then throws, so the
    // adapter's ROLLBACK has no active transaction and fails — the caller
    // must still see "boom", not "cannot rollback".
    expect(() =>
      handle.transaction((db) => {
        db.exec('COMMIT')
        throw new Error('boom')
      }),
    ).toThrow('boom')
  })

  test('rejects an async callback instead of committing before its work finishes', async () => {
    const handle = await open(dbPath, { synchronous: 'normal' })
    handle.db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)')

    expect(() =>
      // @ts-expect-error — deliberately passing an async callback
      handle.transaction(async (db) => {
        db.prepare('INSERT INTO items (id) VALUES (1)').run()
      }),
    ).toThrow(/must be synchronous/)

    const row = handle.db.prepare('SELECT COUNT(*) AS n FROM items').get()
    expect(row).toMatchObject({ n: 0 })
  })

  test('committed changes are visible to a second handle on the same file', async () => {
    const writer = await open(dbPath, { synchronous: 'normal' })
    writer.db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    writer.transaction((db) => {
      db.prepare('INSERT INTO items (name) VALUES (?)').run('shared')
    })

    const reader = await open(dbPath, { synchronous: 'normal' })
    const row = reader.db.prepare('SELECT name FROM items WHERE id = 1').get()
    expect(row).toMatchObject({ name: 'shared' })
  })

  test('throws SqliteBusyError when another connection holds the write lock past the timeout', async () => {
    const holder = await open(dbPath, { synchronous: 'normal' })
    holder.db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    holder.db.exec('BEGIN IMMEDIATE')

    const contender = await open(dbPath, { synchronous: 'normal', busyTimeoutMs: 10 })
    try {
      expect(() => contender.transaction(() => undefined)).toThrow(SqliteBusyError)
    } finally {
      holder.db.exec('ROLLBACK')
    }
  })

  test('succeeds once a previously contending holder has released the lock', async () => {
    const holder = await open(dbPath, { synchronous: 'normal' })
    holder.db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    holder.db.exec('BEGIN IMMEDIATE')

    const contender = await open(dbPath, { synchronous: 'normal', busyTimeoutMs: 10 })
    expect(() => contender.transaction(() => undefined)).toThrow(SqliteBusyError)

    holder.db.exec('ROLLBACK')
    const result = contender.transaction((db) => {
      db.prepare('INSERT INTO items (id) VALUES (1)').run()
      return 'recovered'
    })
    expect(result).toBe('recovered')
  })
})

describe('close()', () => {
  test('a closed handle refuses further work', async () => {
    const handle = await open(dbPath, { synchronous: 'normal' })
    handle.close()
    expect(() => handle.db.prepare('SELECT 1')).toThrow()
  })

  test('closing twice is a no-op, not an error', async () => {
    const handle = await open(dbPath, { synchronous: 'normal' })
    handle.close()
    expect(() => handle.close()).not.toThrow()
  })
})
