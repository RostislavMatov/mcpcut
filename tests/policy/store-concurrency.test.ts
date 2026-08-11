import { readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FORCE_RECOVERY_STALE_FACTOR, type FileLockOptions } from '../../src/lockfile.js'
import {
  StoreCorruptError,
  StoreLockError,
  StoreLockLostError,
  createJsonStore,
  type JsonStore,
} from '../../src/policy/store.js'

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

/** Same store with a short acquisition budget, for the contended paths. */
function openImpatient(): JsonStore<CounterStore> {
  return createJsonStore<CounterStore>(filePath, {
    validate,
    defaultValue: DEFAULT,
    lock: { totalWaitMs: 150 },
  })
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

describe('holder token: a stolen lock is detected instead of assumed', () => {
  /**
   * The stale-lock steal narrowed the double-steal window but could not close
   * it: a recoverer that captured the stale content just before our create
   * still removes our fresh lock and takes over. The holder must therefore
   * verify it STILL owns the lock before committing, and re-run the
   * read-modify-write when it does not — otherwise its write is computed from
   * a snapshot the new owner has already superseded.
   *
   * The interleaving is forced deterministically: the update function itself
   * plays the concurrent recoverer (steal, write, release) on the first call
   * only, so the outer update wakes up holding nothing and must redo its work
   * on top of the value the recoverer committed.
   */
  test('the stolen holder redoes its read-modify-write instead of clobbering the new owner', async () => {
    const lockPath = `${filePath}.lock`
    let sabotaged = false

    const final = await open().update((current) => {
      if (!sabotaged) {
        sabotaged = true
        // A concurrent recoverer steals the lock, commits its own write, and releases.
        writeFileSync(lockPath, JSON.stringify({ pid: 999_999, createdAtMs: Date.now() }), 'utf8')
        writeFileSync(filePath, JSON.stringify({ version: 1, items: { b: 2 } }), 'utf8')
        rmSync(lockPath, { force: true })
      }
      return { ...current, items: { ...current.items, a: 1 } }
    })

    expect(final.items).toEqual({ a: 1, b: 2 })
    expect((await open().read()).items).toEqual({ a: 1, b: 2 })
  })

  test('releasing a lock we no longer own leaves the new owner’s lock in place', async () => {
    const lockPath = `${filePath}.lock`
    const foreign = JSON.stringify({ pid: 999_999, createdAtMs: Date.now() })
    let sabotaged = false

    // The new owner here is live and never releases, so the stolen holder
    // cannot get the lock back: the update must fail loudly rather than write
    // without the lock -- and must leave the live holder's lockfile alone.
    await expect(
      openImpatient().update((current) => {
        if (!sabotaged) {
          sabotaged = true
          writeFileSync(lockPath, foreign, 'utf8')
        }
        return current
      }),
    ).rejects.toBeInstanceOf(StoreLockError)

    expect(readFileSync(lockPath, 'utf8')).toBe(foreign)
  })

  test('losing the lock on every attempt fails loudly and writes nothing', async () => {
    const lockPath = `${filePath}.lock`
    let attempts = 0

    // Every attempt is sabotaged, so no attempt ever reaches its commit. The
    // planted lock is already stale, so the next attempt steals it promptly
    // instead of waiting out the acquisition budget.
    await expect(
      openImpatient().update((current) => {
        attempts += 1
        writeFileSync(
          lockPath,
          JSON.stringify({ pid: 999_999, createdAtMs: Date.now() - 60_000, nonce: 'foreign' }),
          'utf8',
        )
        return { ...current, items: { ...current.items, a: 1 } }
      }),
    ).rejects.toBeInstanceOf(StoreLockLostError)

    expect(attempts).toBe(3)
    expect((await open().read()).items).toEqual({})
  })
})

describe('M4-T2: limited emergency recovery of a broken foreign lock', () => {
  /**
   * Backlog M3 (ROADMAP, «битый чужой лок больше не самоисцеляется»): with
   * three writers (CLI + serve + UI) a lockfile that never answers for itself
   * must not wedge the store forever — deny/revoke run through `update()`, so
   * write availability is itself a security property. The escape is limited:
   * only a lock whose mtime is UNCHANGED between checks and old enough is
   * removed regardless of content, and the operator is told via an injectable
   * `warn` line. A changing mtime is treated as a live writer — fail closed.
   */
  const lockPath = (): string => `${filePath}.lock`

  /** Store wired to a spy `warn` so the operator-visible line is assertable. */
  function openRecovering(
    warnings: string[],
    lock: Partial<FileLockOptions> = {},
  ): JsonStore<CounterStore> {
    return createJsonStore<CounterStore>(filePath, {
      validate,
      defaultValue: DEFAULT,
      lock: { pollMs: 5, warn: (line) => warnings.push(line), ...lock },
    })
  }

  test('an unparseable foreign lock with an unchanged mtime past the staleness window is removed, the write lands, and the operator sees exactly one line', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(lockPath(), 'not a lock record at all', 'utf8')
    // Untouched for 60s: older than any recovery threshold at the default 30s staleMs.
    const past = new Date(Date.now() - 60_000)
    await utimes(lockPath(), past, past)
    const warnings: string[] = []

    const final = await openRecovering(warnings).update((s) => ({
      ...s,
      items: { ...s.items, a: 1 },
    }))

    expect(final.items).toEqual({ a: 1 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(lockPath())
    const leftover = (await readdir(dir)).filter((name) => name.endsWith('.lock'))
    expect(leftover).toEqual([])
  })

  test('a foreign lock whose mtime changes between checks (live writer) is never stolen', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(lockPath(), 'still not a lock record', 'utf8')
    const warnings: string[] = []
    // The "writer" moves mtime to a DIFFERENT old timestamp on every tick, so
    // the age check alone would steal the lock; only the "mtime unchanged
    // between checks" guard stands between this lock and removal.
    let tick = 0
    const rewriter = setInterval(() => {
      tick += 1
      const past = new Date(Date.now() - 120_000 - tick * 1_000)
      try {
        utimesSync(lockPath(), past, past)
      } catch {
        // If the lock IS wrongly stolen, utimes hits ENOENT; swallowing it
        // here lets the assertions below report the clean failure instead of
        // an unhandled exception crashing the worker.
      }
    }, 3)

    try {
      await expect(
        openRecovering(warnings, { totalWaitMs: 120, pollMs: 15 }).update((s) => s),
      ).rejects.toBeInstanceOf(StoreLockError)
    } finally {
      clearInterval(rewriter)
    }

    expect(warnings).toEqual([])
    expect(readFileSync(lockPath(), 'utf8')).toBe('still not a lock record')
  })

  test('a lock whose record claims to be fresh but whose mtime is ancient and unchanged is forcibly removed after N x staleMs', async () => {
    await mkdir(dir, { recursive: true })
    // A lying record: createdAtMs a day in the FUTURE, so content-based
    // staleness never fires — before the emergency escape, this wedged the
    // store forever. The file itself has not been touched for 60s.
    const lying = JSON.stringify({
      pid: 999_999,
      createdAtMs: Date.now() + 86_400_000,
      nonce: 'feedfeedfeedfeedfeedfeedfeedfeed',
    })
    await writeFile(lockPath(), lying, 'utf8')
    const past = new Date(Date.now() - 60_000)
    await utimes(lockPath(), past, past)
    const warnings: string[] = []
    // staleMs chosen so N x staleMs is comfortably below the 60s mtime age.
    const staleMs = Math.floor(55_000 / FORCE_RECOVERY_STALE_FACTOR)

    const final = await openRecovering(warnings, { staleMs }).update((s) => ({
      ...s,
      items: { ...s.items, healed: 1 },
    }))

    expect(final.items).toEqual({ healed: 1 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(lockPath())
  })
})
