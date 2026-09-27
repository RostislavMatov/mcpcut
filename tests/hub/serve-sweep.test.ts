import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { findAccountByGithubId, insertAccount, openAccountsDb, setStatus, type AccountRecord } from '../../hub/src/accounts-db.js'
import { DEFAULT_SWEEP_SCHEDULE } from '../../hub/src/idle-sweeper.js'
import { unavailableOrchestrator } from '../../hub/src/orchestrator.js'
import { createFakeOrchestrator } from './fake-orchestrator.js'
import { manualScheduler, startServe, waitForOutput } from './serve-harness.js'

/**
 * `hub serve` runs the idle sweeper on a schedule (plan `hosted-path-and-ops`,
 * Task C, P5): a minute after it starts, then every six hours, only with an
 * orchestrator, and never after shutdown. One test runs the real timer on a
 * shortened schedule and waits for its effect by condition; the others drive
 * the schedule by hand, so "no further sweep" is checked without a pause (the
 * real timer's own stop is `idle-sweeper.test.ts`'s, on fake timers).
 */

const NOW_MS = Date.parse('2026-09-27T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const SHORT_SCHEDULE = { firstDelayMs: 20, intervalMs: 20 }
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-hub-serve-sweep-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const dataDir = (): string => join(dir, 'data')

async function seedActive(login: string, seenDaysAgo: number): Promise<void> {
  const db = await openAccountsDb(dataDir())
  try {
    const now = new Date(NOW_MS - seenDaysAgo * DAY).toISOString()
    insertAccount(db, { githubId: 1, login, subdomain: login, githubCreatedAt: '2019-01-01T00:00:00Z', now }, 100)
    setStatus(db, 1, 'active')
  } finally {
    db.handle.close()
  }
}

async function readAccount(): Promise<AccountRecord | null> {
  const db = await openAccountsDb(dataDir())
  try {
    return findAccountByGithubId(db, 1)
  } finally {
    db.handle.close()
  }
}

const listening = (text: string): boolean => text.includes('listening on')

describe('hub serve and the idle sweeper', () => {
  test('sweeps on the schedule: an install idle for 61 days is stopped', async () => {
    await seedActive('idle', 61)
    const orchestrator = createFakeOrchestrator()
    orchestrator.addInstall('idle')
    const hub = await startServe(dir, dataDir(), { orchestrator, clock: () => NOW_MS, sweepSchedule: SHORT_SCHEDULE })

    await waitForOutput(hub, (text) => text.includes('— stopped'))

    expect(await hub.stop()).toBe(0)
    expect(hub.out()).toContain('[hub] idle sweep: @idle (idle) idle 61 d — stopped')
    expect(hub.out()).toContain('[hub] idle sweep: first in 20 ms, then every 20 ms')
    expect(orchestrator.install('idle')?.running).toBe(false)
    expect((await readAccount())?.stoppedAt).toBe(new Date(NOW_MS).toISOString())
  })

  test('each tick of the schedule is a sweep, and shutdown stops the schedule', async () => {
    await seedActive('fresh', 1)
    const orchestrator = createFakeOrchestrator()
    orchestrator.addInstall('fresh')
    const schedule = manualScheduler()
    const hub = await startServe(dir, dataDir(), { orchestrator, clock: () => NOW_MS, sweepSchedule: SHORT_SCHEDULE, sweepScheduler: schedule.scheduler })
    await waitForOutput(hub, listening)

    await schedule.tick()
    await schedule.tick()
    expect(schedule.isStopped()).toBe(false)

    expect(await hub.stop()).toBe(0)
    expect(hub.out().split('@fresh (fresh) idle 1 d — kept')).toHaveLength(3)
    expect(schedule.scheduled()).toEqual([SHORT_SCHEDULE])
    expect(schedule.isStopped()).toBe(true)
  })

  test('with no orchestrator nothing is scheduled', async () => {
    await seedActive('idle', 400)
    const schedule = manualScheduler()
    const hub = await startServe(dir, dataDir(), { orchestrator: unavailableOrchestrator, clock: () => NOW_MS, sweepScheduler: schedule.scheduler })
    await waitForOutput(hub, listening)

    expect(await hub.stop()).toBe(0)
    expect(schedule.scheduled()).toEqual([])
    expect(hub.out()).not.toContain('idle sweep')
    expect((await readAccount())?.status).toBe('active')
  })

  test('the production schedule: a minute after start, then every six hours', () => {
    expect(DEFAULT_SWEEP_SCHEDULE).toEqual({ firstDelayMs: 60_000, intervalMs: 21_600_000 })
  })
})
