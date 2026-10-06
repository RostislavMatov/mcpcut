import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FILES_PG_URL_SECRET } from '../../src/files/db/constants.js'
import type { FilesDb } from '../../src/files/db/connection.js'
import { loadPg } from '../../src/files/db/pg-loader.js'
import type { PgModule } from '../../src/files/db/pg-types.js'
import {
  FILES_SYNC_INTERVAL_MS,
  FILES_WALK_INTERVAL_MS,
  startFilesSync,
  type FilesSync,
  type FilesSyncDeps,
  type FilesSyncTimer,
} from '../../src/cli/serve-files-sync.js'
import { createVaultStore } from '../../src/vault/store.js'
import { call, writeJournal } from '../files/db/journal-fixtures.js'
import { describePg, PG_URL, withTestSchema } from '../files/db/pg-helpers.js'

/** The Postgres sync inside `serve`, driven by a timer that ticks on demand. */

let base: string
let journalDir: string
let folder: string
let clock: number
const cleanups: Array<() => Promise<void>> = []
const opened: FilesDb[] = []
const stops: FilesSync[] = []

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-serve-files-sync-')))
  journalDir = join(base, 'state')
  folder = join(base, 'data')
  clock = Date.parse('2026-10-05T12:00:00.000Z')
  await mkdir(journalDir, { recursive: true })
  await mkdir(folder, { recursive: true })
})

afterEach(async () => {
  await Promise.all(stops.splice(0).map((sync) => sync.stop()))
  opened.splice(0)
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  await rm(base, { recursive: true, force: true })
})

interface FakeTimer extends FilesSyncTimer {
  readonly calls: Array<{ ms: number; unrefed: boolean; cleared: boolean; tick: () => void }>
}

function fakeTimer(): FakeTimer {
  const calls: FakeTimer['calls'] = []
  return {
    calls,
    setInterval: (tick, ms) => {
      const call = { ms, unrefed: false, cleared: false, tick }
      calls.push(call)
      return { unref: () => { call.unrefed = true }, call } as never
    },
    clearInterval: (handle) => {
      ;(handle as unknown as { call: { cleared: boolean } }).call.cleared = true
    },
  }
}

function start(timer: FakeTimer, extra: { schema?: string; installed?: boolean; loadPg?: () => Promise<PgModule>; walk?: FilesSyncDeps['walk'] } = {}) {
  const lines: string[] = []
  const sync = startFilesSync({
    journalDir,
    cli: 'mcpcut',
    listRoots: async () => [folder],
    stderr: { write: (chunk: string) => void lines.push(chunk) },
    now: () => clock,
    platform: 'linux',
    timer,
    loadPg: extra.loadPg ?? (extra.installed === false ? () => Promise.reject(new Error('boom')) : () => loadPg(process.cwd())),
    ...(extra.walk !== undefined ? { walk: extra.walk } : {}),
    ...(extra.schema !== undefined ? { schema: extra.schema } : {}),
    onOpen: (db) => opened.push(db),
  })
  stops.push(sync)
  return { sync, lines }
}

async function tick(timer: FakeTimer, sync: FilesSync, advanceMs = FILES_SYNC_INTERVAL_MS): Promise<void> {
  clock += advanceMs
  timer.calls[0]?.tick()
  await sync.idle()
}

/** Without a test Postgres, a well-formed URL nothing listens on: tests that never connect still read one. */
const URL_OR_PLACEHOLDER = PG_URL === '' ? 'postgres://mcpcut:placeholder@127.0.0.1:1/none' : PG_URL

async function turnOn(url = URL_OR_PLACEHOLDER): Promise<void> {
  await createVaultStore({ journalDir }).init()
  await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, url)
}

describe('startFilesSync: mode off', () => {
  test('without a vault it does nothing and prints nothing, and the timer is unref-ed', async () => {
    const timer = fakeTimer()
    const { sync, lines } = start(timer)
    await sync.done
    await tick(timer, sync)
    expect(lines).toEqual([])
    expect(opened).toHaveLength(0)
    expect(timer.calls[0]).toMatchObject({ ms: FILES_SYNC_INTERVAL_MS, unrefed: true })
    await sync.stop()
    expect(timer.calls[0]?.cleared).toBe(true)
  })
})

describe('startFilesSync: failures never stop serve', () => {
  test('an unreachable server is one line per distinct reason, not per tick', async () => {
    await turnOn('postgres://u:pw-secret@127.0.0.1:1/db')
    const timer = fakeTimer()
    const { sync, lines } = start(timer)
    await sync.done
    await tick(timer, sync)
    await tick(timer, sync)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[serve\] files sync: Postgres at 127\.0\.0\.1:1 is not reachable/)
    expect(lines[0]).not.toContain('pw-secret')
  })

  test('a client that fails to load is reported once', async () => {
    await turnOn()
    const timer = fakeTimer()
    const { sync, lines } = start(timer, { installed: false })
    await sync.done
    await tick(timer, sync)
    expect(lines).toEqual(['[serve] files sync: boom\n'])
  })
})

describePg('startFilesSync on a real Postgres', () => {
  async function rows(db: FilesDb | undefined, table: string): Promise<number> {
    const result = await db?.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)
    return Number(result?.rows[0]?.n ?? 0)
  }

  test('start ingests and walks; a tick ingests; the walk waits an hour', async () => {
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await turnOn()
    await writeFile(join(folder, 'a.txt'), 'a')
    await writeJournal(journalDir, 's1', [call({ payload: { path: join(folder, 'a.txt') } })])
    const timer = fakeTimer()
    const { sync, lines } = start(timer, { schema })

    await sync.done
    const db = opened[0]
    expect(await rows(db, 'file_events')).toBe(1)
    expect(await rows(db, 'catalog')).toBe(1)

    await writeFile(join(folder, 'b.txt'), 'b')
    await writeJournal(journalDir, 's2', [call({ payload: { path: join(folder, 'b.txt') } })])
    await tick(timer, sync)
    expect(await rows(db, 'file_events')).toBe(2)
    expect(await rows(db, 'catalog')).toBe(1)

    await tick(timer, sync, FILES_WALK_INTERVAL_MS)
    expect(await rows(db, 'catalog')).toBe(2)
    expect(lines).toEqual([])
    expect(opened).toHaveLength(1)
  })

  test('a write the journal names is refreshed in the catalog before the next walk', async () => {
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await turnOn()
    const timer = fakeTimer()
    const { sync } = start(timer, { schema })
    await sync.done
    await writeFile(join(folder, 'w.txt'), 'w')
    await writeJournal(journalDir, 's1', [call({ tool: 'write_file', payload: { path: join(folder, 'w.txt'), content: 'w' } })])

    await tick(timer, sync)

    expect(await rows(opened[0], 'catalog')).toBe(1)
  })

  test('a failed open is retried on the next tick and reported once; stop closes the handle', async () => {
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await turnOn('postgres://mcpcut:wrong@127.0.0.1:55439/mcpcut_test')
    const timer = fakeTimer()
    const { sync, lines } = start(timer, { schema })
    await sync.done
    await tick(timer, sync)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('refused the login')

    await turnOn()
    await tick(timer, sync)
    expect(opened).toHaveLength(1)
    await sync.stop()
    await expect(opened[0]?.query('SELECT 1')).rejects.toThrow()
  })
})

/** A promise settled by hand, to hold a run in flight. */
function gate<T>(): { promise: Promise<T>; open: (value: T) => void } {
  let open!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

const hasSettled = async (promise: Promise<unknown>): Promise<boolean> =>
  Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))])

describe('startFilesSync: lifecycle', () => {
  test('a tick during a running sync does not make idle() resolve early', async () => {
    await turnOn('postgres://u:pw@127.0.0.1:1/db')
    const slow = gate<PgModule>()
    const timer = fakeTimer()
    const { sync, lines } = start(timer, { loadPg: () => slow.promise })

    timer.calls[0]?.tick()
    const idle = sync.idle()

    expect(await hasSettled(idle)).toBe(false)
    slow.open(await loadPg(process.cwd()))
    await idle
    expect(lines).toHaveLength(1)
    await sync.done
  })

  test.skipIf(PG_URL === '')('stop waits for a run in flight, then closes what it opened', async () => {
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await turnOn()
    const slow = gate<PgModule>()
    const timer = fakeTimer()
    const { sync } = start(timer, { schema, loadPg: () => slow.promise })

    const stopping = sync.stop()

    expect(await hasSettled(stopping)).toBe(false)
    slow.open(await loadPg(process.cwd()))
    await stopping
    expect(opened).toHaveLength(1)
    await expect(opened[0]?.query('SELECT 1')).rejects.toThrow()
    expect(timer.calls[0]?.cleared).toBe(true)
  })

  test('a tick after stop starts nothing', async () => {
    await turnOn('postgres://u:pw@127.0.0.1:1/db')
    const timer = fakeTimer()
    const { sync, lines } = start(timer, { installed: false })
    await sync.stop()
    lines.length = 0

    timer.calls[0]?.tick()
    await sync.idle()

    expect(lines).toEqual([])
  })
})

describePg('startFilesSync: the walk is its own step', () => {
  async function eventsIn(db: FilesDb | undefined): Promise<number> {
    const result = await db?.query<{ n: string }>('SELECT count(*) AS n FROM file_events')
    return Number(result?.rows[0]?.n ?? 0)
  }

  test('the minute ingest keeps running while a long walk is in progress, and the walk is not started twice', async () => {
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await turnOn()
    await writeJournal(journalDir, 's1', [call({ payload: { path: join(folder, 'a.txt') } })])
    const longWalk = gate<[]>()
    const walk = vi.fn(async () => longWalk.promise)
    const timer = fakeTimer()
    const { sync } = start(timer, { schema, walk })

    await vi.waitFor(async () => expect(await eventsIn(opened[0])).toBe(1))
    await writeJournal(journalDir, 's2', [call({ payload: { path: join(folder, 'b.txt') } })])
    clock += FILES_SYNC_INTERVAL_MS
    timer.calls[0]?.tick()

    await vi.waitFor(async () => expect(await eventsIn(opened[0])).toBe(2))
    expect(walk).toHaveBeenCalledTimes(1)
    expect(await hasSettled(sync.done)).toBe(false)
    longWalk.open([])
    await sync.done
  })

  test('a failed walk is reported and retried on the next tick', async () => {
    const { schema, cleanup } = withTestSchema()
    cleanups.push(cleanup)
    await turnOn()
    const walk = vi.fn<NonNullable<FilesSyncDeps['walk']>>().mockRejectedValueOnce(new Error('disk gone')).mockResolvedValue([])
    const timer = fakeTimer()
    const { sync, lines } = start(timer, { schema, walk })
    await sync.done
    expect(lines).toEqual(['[serve] files sync: disk gone\n'])

    await tick(timer, sync)

    expect(walk).toHaveBeenCalledTimes(2)
  })
})
