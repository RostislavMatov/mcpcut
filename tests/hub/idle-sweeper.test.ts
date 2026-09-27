import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { markStopped, markStoppedWhileBlocked } from '../../hub/src/accounts-idle.js'
import {
  findAccountByGithubId,
  findTombstone,
  insertAccount,
  openAccountsDb,
  setStatus,
  type AccountRecord,
  type AccountsDb,
} from '../../hub/src/accounts-db.js'
import { createIdleSweeper, scheduleSweeps, type IdleSweeper, type IdleSweeperDeps } from '../../hub/src/idle-sweeper.js'
import type { ReconcileSummary } from '../../hub/src/provisioning.js'
import { createFakeOrchestrator, type FakeOrchestrator } from './fake-orchestrator.js'

/**
 * One sweep of the idle sweeper (plan `hosted-path-and-ops`, Task C, P5/P6)
 * over a real `hub.db` and the fake orchestrator: each active account is
 * inspected, decided and acted on — stop at 60 idle days, remove (without a
 * tombstone) at 90 — with one log line each; a failure on one account does
 * not stop the rest; `pending` rows are settled again every cycle.
 */

const NOW_MS = Date.parse('2026-09-27T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const iso = (ms: number): string => new Date(ms).toISOString()
const daysAgo = (days: number): string => iso(NOW_MS - days * DAY)

let dir: string
let db: AccountsDb
let orchestrator: FakeOrchestrator
let logs: string[]
let reconciles: number
let waking: Set<number>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-hub-idle-sweeper-test-'))
  db = await openAccountsDb(dir)
  orchestrator = createFakeOrchestrator()
  logs = []
  reconciles = 0
  waking = new Set()
})

afterEach(async () => {
  db.handle.close()
  await rm(dir, { recursive: true, force: true })
})

const SETTLED: ReconcileSummary = { activated: 0, discarded: 0, leftPending: 0 }

function sweeper(overrides: Partial<IdleSweeperDeps> = {}): IdleSweeper {
  return createIdleSweeper({
    db,
    orchestrator,
    clock: () => NOW_MS,
    log: (line) => logs.push(line),
    reconcilePending: async () => {
      reconciles += 1
      return SETTLED
    },
    isWaking: (githubId) => waking.has(githubId),
    ...overrides,
  })
}

/** An active account last seen `seenDaysAgo` days ago, with a running install. */
function account(githubId: number, login: string, seenDaysAgo: number, install: { lastActivityAt?: string | null; running?: boolean } = {}): AccountRecord {
  const inserted = insertAccount(
    db,
    { githubId, login, subdomain: login, githubCreatedAt: '2019-01-01T00:00:00Z', now: daysAgo(seenDaysAgo) },
    100,
  )
  if (!inserted.ok) throw new Error(`could not seed ${login}`)
  setStatus(db, githubId, 'active')
  orchestrator.addInstall(login, { running: install.running ?? true, lastActivityAt: install.lastActivityAt ?? null })
  return { ...inserted.account, status: 'active' }
}

const line = (login: string): string => logs.find((entry) => entry.includes(`@${login} `)) ?? ''

describe('one sweep', () => {
  test('keeps a used install, stops one idle for 60 days, removes one idle for 90', async () => {
    account(1, 'fresh', 1)
    account(2, 'agentuser', 120, { lastActivityAt: daysAgo(2) })
    account(3, 'idle', 61)
    account(4, 'gone', 91)

    const summary = await sweeper().sweep()

    expect(summary.entries.map((entry) => [entry.login, entry.outcome, entry.applied])).toEqual([
      ['agentuser', 'keep', false],
      ['gone', 'remove', true],
      ['idle', 'stop', true],
      ['fresh', 'keep', false],
    ])
    expect(orchestrator.install('idle')?.running).toBe(false)
    expect(findAccountByGithubId(db, 3)?.stoppedAt).toBe(iso(NOW_MS))
    expect(orchestrator.installs()).not.toContain('gone')
    expect(findAccountByGithubId(db, 4)).toBeNull()
    expect(orchestrator.install('fresh')?.running).toBe(true)
    expect(orchestrator.install('agentuser')?.running).toBe(true)
  })

  test('one log line per account, naming the decision and the idle days', async () => {
    account(1, 'fresh', 1)
    account(3, 'idle', 61)
    account(4, 'gone', 91)

    await sweeper().sweep()

    expect(line('fresh')).toBe('[hub] idle sweep: @fresh (fresh) idle 1 d — kept')
    expect(line('idle')).toBe('[hub] idle sweep: @idle (idle) idle 61 d — stopped')
    expect(line('gone')).toBe('[hub] idle sweep: @gone (gone) idle 91 d — removed with its account (no tombstone)')
  })

  test('a removed account leaves no tombstone: the person signs up again as new', async () => {
    account(4, 'gone', 91)

    await sweeper().sweep()

    expect(findTombstone(db, 4)).toBeNull()
    const again = insertAccount(db, { githubId: 4, login: 'gone', subdomain: 'gone', githubCreatedAt: '2019-01-01T00:00:00Z', now: iso(NOW_MS) }, 100)
    expect(again.ok).toBe(true)
  })

  test('a stopped install is removed 30 days after the stop, not before', async () => {
    const alice = account(1, 'alice', 200, { running: false })
    markStopped(db, { githubId: alice.githubId, createdAt: alice.createdAt }, daysAgo(29))

    expect((await sweeper().sweep()).entries[0]?.outcome).toBe('keep')
    expect(orchestrator.calls().filter((call) => call.method !== 'inspect')).toEqual([])

    db.handle.db.prepare('UPDATE accounts SET stopped_at = ? WHERE github_id = 1').run(daysAgo(30))
    expect((await sweeper().sweep()).entries[0]?.outcome).toBe('remove')
    expect(findAccountByGithubId(db, 1)).toBeNull()
  })

  test('an install found running under a stop mark (started by hand) loses the mark and is judged by its activity', async () => {
    const alice = account(1, 'alice', 200, { running: true, lastActivityAt: daysAgo(3) })
    markStopped(db, { githubId: alice.githubId, createdAt: alice.createdAt }, daysAgo(40))

    const [entry] = (await sweeper().sweep()).entries

    expect(entry?.outcome).toBe('keep')
    expect(findAccountByGithubId(db, 1)?.stoppedAt).toBeNull()
  })

  test('a failure on one account is logged and the others are still swept', async () => {
    account(1, 'first', 91)
    account(2, 'second', 61)
    orchestrator.fail('remove', 'provisioner remove: the provisioner could not be reached (ECONNREFUSED)')

    const summary = await sweeper().sweep()

    expect(summary.entries.map((entry) => entry.outcome)).toEqual(['failed', 'stop'])
    expect(line('first')).toContain('failed, will try again next sweep: Error: provisioner remove')
    expect(findAccountByGithubId(db, 1)).not.toBeNull()
    expect(orchestrator.install('second')?.running).toBe(false)
  })

  test('an inspect that fails decides nothing', async () => {
    account(1, 'alice', 400)
    orchestrator.fail('inspect')

    const [entry] = (await sweeper().sweep()).entries

    expect(entry?.outcome).toBe('failed')
    expect(findAccountByGithubId(db, 1)).not.toBeNull()
    expect(orchestrator.calls().map((call) => call.method)).toEqual(['inspect'])
  })

  test('an account whose install is being started again is left for the next sweep', async () => {
    account(1, 'alice', 400)
    waking.add(1)

    const [entry] = (await sweeper().sweep()).entries

    expect(entry?.outcome).toBe('skipped')
    expect(orchestrator.calls()).toEqual([])
  })

  test('a sign-in between the decision and the removal saves the account', async () => {
    account(1, 'alice', 91)
    orchestrator.hold('inspect')
    const sweeping = sweeper().sweep()
    await vi.waitFor(() => expect(orchestrator.calls()).toHaveLength(1))
    db.handle.db.prepare('UPDATE accounts SET last_seen_at = ? WHERE github_id = 1').run(iso(NOW_MS))
    orchestrator.release('inspect')

    const [entry] = (await sweeping).entries

    expect(entry?.outcome).toBe('keep')
    expect(orchestrator.installs()).toContain('alice')
    expect(findAccountByGithubId(db, 1)).not.toBeNull()
  })

  test('pending accounts and blocked ones already stopped are not swept', async () => {
    insertAccount(db, { githubId: 1, login: 'pend', subdomain: 'pend', githubCreatedAt: '2019-01-01T00:00:00Z', now: daysAgo(400) }, 100)
    account(2, 'blocked', 400, { running: false })
    setStatus(db, 2, 'blocked')
    markStoppedWhileBlocked(db, { githubId: 2, createdAt: daysAgo(400) }, daysAgo(1))

    expect((await sweeper().sweep()).entries).toEqual([])
    expect(orchestrator.calls()).toEqual([])
  })
})

describe('a sweep that cannot even list the accounts', () => {
  test('logs once and resolves with nothing swept', async () => {
    const idle = sweeper()
    db.handle.close()

    const summary = await idle.sweep()

    expect(summary.entries).toEqual([])
    expect(logs.join('\n')).toContain('[hub] idle sweep failed:')
    db = await openAccountsDb(dir)
  })
})

describe('an active account whose install is missing', () => {
  test('is kept, logged, and flagged for its /account page — never removed quietly', async () => {
    const alice = account(1, 'alice', 400)
    await orchestrator.remove('alice')
    const idle = sweeper()

    const [entry] = (await idle.sweep()).entries

    expect(entry?.outcome).toBe('missing')
    expect(findAccountByGithubId(db, 1)).not.toBeNull()
    expect(line('alice')).toBe('[hub] idle sweep: @alice (alice) — install missing, account kept for the operator')
    expect(idle.isMissing({ githubId: 1, createdAt: alice.createdAt })).toBe(true)
    expect(idle.isMissing({ githubId: 1, createdAt: 'another row' })).toBe(false)
  })

  test('the flag clears once the install is back', async () => {
    const alice = account(1, 'alice', 1)
    await orchestrator.remove('alice')
    const idle = sweeper()
    await idle.sweep()

    orchestrator.addInstall('alice')
    await idle.sweep()

    expect(idle.isMissing({ githubId: 1, createdAt: alice.createdAt })).toBe(false)
  })
})

describe('pending accounts and dry runs', () => {
  test('every sweep settles pending accounts again (a provisioner down at start)', async () => {
    const idle = sweeper()
    await idle.sweep()
    await idle.sweep()

    expect(reconciles).toBe(2)
  })

  test('without a reconcile (the operator’s command) no pending account is touched', async () => {
    const summary = await sweeper({ reconcilePending: undefined }).sweep()

    expect(summary.pending).toBeUndefined()
  })

  test('a dry run decides but changes nothing, and does not settle pending accounts', async () => {
    account(3, 'idle', 61)
    account(4, 'gone', 91)
    const alice = account(5, 'alice', 1)
    await orchestrator.remove('alice')
    const idle = sweeper()

    const summary = await idle.sweep({ dryRun: true })

    expect(summary.entries.map((entry) => [entry.login, entry.outcome, entry.applied])).toEqual([
      ['gone', 'remove', false],
      ['idle', 'stop', false],
      ['alice', 'missing', false],
    ])
    expect(orchestrator.calls().map((call) => call.method).filter((method) => method !== 'inspect')).toEqual(['remove'])
    expect(findAccountByGithubId(db, 4)).not.toBeNull()
    expect(findAccountByGithubId(db, 3)?.stoppedAt).toBeNull()
    expect(idle.isMissing({ githubId: 5, createdAt: alice.createdAt })).toBe(false)
    expect(reconciles).toBe(0)
    expect(line('gone')).toContain('would be removed')
  })
})

describe('scheduleSweeps', () => {
  test('first after the delay, then on the interval; nothing after stop', async () => {
    vi.useFakeTimers()
    try {
      let runs = 0
      const schedule = scheduleSweeps(async () => void (runs += 1), { firstDelayMs: 60_000, intervalMs: 6 * 60 * 60 * 1000 })

      await vi.advanceTimersByTimeAsync(59_999)
      expect(runs).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(runs).toBe(1)
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
      expect(runs).toBe(2)
      schedule.stop()
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      expect(runs).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('a run that throws does not end the schedule', async () => {
    vi.useFakeTimers()
    try {
      let runs = 0
      const schedule = scheduleSweeps(
        async () => {
          runs += 1
          throw new Error('boom')
        },
        { firstDelayMs: 10, intervalMs: 10 },
      )
      await vi.advanceTimersByTimeAsync(35)
      schedule.stop()
      expect(runs).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
