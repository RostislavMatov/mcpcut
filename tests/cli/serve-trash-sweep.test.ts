import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { TRASH_DIR_NAME } from '../../src/files/constants.js'
import { writeManifest } from '../../src/files/trash-manifest.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import { searchSession } from '../../src/journal/search.js'
import {
  TRASH_SWEEP_INTERVAL_MS,
  journalPurgeTo,
  startTrashSweep,
  type TrashSweepTimer,
} from '../../src/cli/serve-trash-sweep.js'

/** The automatic purge in `serve` (ADR-0020 §4): 30 days, every declared root, never fatal. */

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0)
const ID_OLD = '01K9Z3Q8M5R7T2V4X6B8D0F2JK'
const ID_NEW = '01K9Z3Q8M5R7T2V4X6B8D0F1GH'

let base: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-trash-sweep-')))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

async function rootWith(name: string, entries: ReadonlyArray<{ id: string; ageDays: number }>): Promise<string> {
  const root = join(base, name)
  const trashDir = join(root, TRASH_DIR_NAME)
  await mkdir(trashDir, { recursive: true })
  for (const { id, ageDays } of entries) {
    await mkdir(join(trashDir, id))
    await writeFile(join(trashDir, id, 'f.txt'), 'x')
    const written = await writeManifest(trashDir, {
      id,
      root,
      relative: 'f.txt',
      originalPath: join(root, 'f.txt'),
      kind: 'file',
      size: 1,
      deletedAt: new Date(NOW - ageDays * DAY_MS).toISOString(),
      deletedBy: 'bot',
    })
    expect(written.ok).toBe(true)
  }
  return root
}

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false)

interface FakeTimer extends TrashSweepTimer {
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

function stderrCapture(): { lines: string[]; stderr: { write: (chunk: string) => void } } {
  const lines: string[] = []
  return { lines, stderr: { write: (chunk: string) => void lines.push(chunk) } }
}

describe('startTrashSweep', () => {
  test('purges entries older than 30 days in every declared root at startup', async () => {
    const one = await rootWith('one', [{ id: ID_OLD, ageDays: 31 }, { id: ID_NEW, ageDays: 29 }])
    const two = await rootWith('two', [{ id: ID_OLD, ageDays: 90 }])
    const { stderr, lines } = stderrCapture()

    const sweep = startTrashSweep({ listRoots: async () => [one, two], stderr, now: () => NOW, timer: fakeTimer() })
    await sweep.done

    expect(await exists(join(one, TRASH_DIR_NAME, `${ID_OLD}.json`))).toBe(false)
    expect(await exists(join(one, TRASH_DIR_NAME, `${ID_NEW}.json`))).toBe(true)
    expect(await exists(join(two, TRASH_DIR_NAME, `${ID_OLD}.json`))).toBe(false)
    expect(lines).toEqual([])
    sweep.stop()
  })

  test('journals each root it purged something from, and nothing for a root it left alone', async () => {
    const one = await rootWith('one', [{ id: ID_OLD, ageDays: 31 }])
    const two = await rootWith('two', [{ id: ID_NEW, ageDays: 1 }])
    const journaled: Array<{ root: string; deletedCount: number }> = []

    const sweep = startTrashSweep({
      listRoots: async () => [one, two],
      stderr: stderrCapture().stderr,
      now: () => NOW,
      timer: fakeTimer(),
      journalPurge: async (root, deletedCount) => void journaled.push({ root, deletedCount }),
    })
    await sweep.done

    expect(journaled).toEqual([{ root: one, deletedCount: 1 }])
    sweep.stop()
  })

  test('a journal that fails is one stderr line, not a stopped sweep', async () => {
    const one = await rootWith('one', [{ id: ID_OLD, ageDays: 31 }])
    const { stderr, lines } = stderrCapture()

    const sweep = startTrashSweep({
      listRoots: async () => [one],
      stderr,
      now: () => NOW,
      timer: fakeTimer(),
      journalPurge: async () => {
        throw new Error('disk full')
      },
    })
    await sweep.done

    expect(await exists(join(one, TRASH_DIR_NAME, `${ID_OLD}.json`))).toBe(false)
    expect(lines.join('')).toContain('purged 1 item(s) but the journal record failed: disk full')
    sweep.stop()
  })

  test('schedules every 24 hours with an unref-ed timer and runs again on each tick', async () => {
    const root = await rootWith('r', [])
    const timer = fakeTimer()
    let clock = NOW
    const sweep = startTrashSweep({ listRoots: async () => [root], stderr: stderrCapture().stderr, now: () => clock, timer })
    await sweep.done
    expect(timer.calls).toHaveLength(1)
    expect(timer.calls[0]).toMatchObject({ ms: TRASH_SWEEP_INTERVAL_MS, unrefed: true })
    expect(TRASH_SWEEP_INTERVAL_MS).toBe(DAY_MS)

    // An entry that is 20 days old today is 31 days old after eleven more days.
    const trashDir = join(root, TRASH_DIR_NAME)
    await mkdir(join(trashDir, ID_OLD))
    await writeManifest(trashDir, {
      id: ID_OLD, root, relative: 'f.txt', originalPath: join(root, 'f.txt'), kind: 'file', size: 0,
      deletedAt: new Date(NOW - 20 * DAY_MS).toISOString(), deletedBy: 'bot',
    })
    clock = NOW + 11 * DAY_MS
    timer.calls[0]?.tick()
    await sweep.idle()

    expect(await exists(join(trashDir, `${ID_OLD}.json`))).toBe(false)
    sweep.stop()
  })

  test('stop clears the timer', async () => {
    const timer = fakeTimer()
    const sweep = startTrashSweep({ listRoots: async () => [], stderr: stderrCapture().stderr, now: () => NOW, timer })
    await sweep.done

    sweep.stop()

    expect(timer.calls[0]?.cleared).toBe(true)
  })

  test('a root without a trash is one stderr line and the other roots are still swept', async () => {
    const bare = join(base, 'bare')
    await mkdir(bare)
    const good = await rootWith('good', [{ id: ID_OLD, ageDays: 40 }])
    const { stderr, lines } = stderrCapture()

    await startTrashSweep({ listRoots: async () => [bare, good], stderr, now: () => NOW, timer: fakeTimer() }).done

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[serve] trash sweep')
    expect(lines[0]).toContain(bare)
    expect(lines[0]?.trimEnd().includes('\n')).toBe(false)
    expect(await exists(join(good, TRASH_DIR_NAME, `${ID_OLD}.json`))).toBe(false)
  })

  test('a roots store that throws is one stderr line and never rejects', async () => {
    const { stderr, lines } = stderrCapture()

    const sweep = startTrashSweep({
      listRoots: async () => { throw new Error('state.db is locked') },
      stderr,
      now: () => NOW,
      timer: fakeTimer(),
    })

    await expect(sweep.done).resolves.toBeUndefined()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('state.db is locked')
    sweep.stop()
  })

  test('a throwing stderr cannot crash the sweep', async () => {
    const stderr = { write: (): void => { throw new Error('EPIPE') } }

    const sweep = startTrashSweep({
      listRoots: async () => { throw new Error('boom') },
      stderr,
      now: () => NOW,
      timer: fakeTimer(),
    })

    await expect(sweep.done).resolves.toBeUndefined()
    sweep.stop()
  })

  test('uses the real timers by default and unrefs them so serve can exit', async () => {
    const sweep = startTrashSweep({ listRoots: async () => [], stderr: stderrCapture().stderr, now: () => NOW })

    await sweep.done
    sweep.stop()
  })
})

describe('journalPurgeTo', () => {
  test('writes one access-edit for files.trash.purge with no admin, via serve', async () => {
    const journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-sweep-journal-'))
    try {
      await journalPurgeTo(journalDir, stderrCapture().stderr)('/data/root', 3)

      const page = await searchSession(ACCESS_EDIT_SESSION_ID, { kind: 'access-edit', dir: journalDir })
      expect(page.records.map((record) => record.payload)).toEqual([
        expect.objectContaining({ action: 'files.trash.purge', path: '/data/root', deletedCount: 3, olderThan: '30d', actor: { adminName: null, role: null, via: 'serve' } }),
      ])
    } finally {
      await rm(journalDir, { recursive: true, force: true })
    }
  })
})
