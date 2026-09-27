import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { findAccountByGithubId, insertAccount, openAccountsDb, setStatus, type AccountsDb } from '../../hub/src/accounts-db.js'
import { createIdleSweeper, type IdleSweeper } from '../../hub/src/idle-sweeper.js'
import { createFakeOrchestrator, type FakeOrchestrator } from './fake-orchestrator.js'

/**
 * The idle sweeper's safety net for blocked accounts (plan
 * `hosted-path-and-ops`, stage-4 review, security MEDIUM): an install of a
 * blocked account must not run. The operator's `block` stops it, but a block
 * made while the install was still being created, before this rule, or from
 * a shell without the provisioner link leaves it running — every sweep stops
 * such an install and marks it stopped, so the next sweep leaves it alone and
 * an `unblock` + sign-in starts it again.
 */

const NOW_MS = Date.parse('2026-09-27T12:00:00.000Z')
const CREATED = '2026-09-26T12:00:00.000Z'

let dir: string
let db: AccountsDb
let orchestrator: FakeOrchestrator
let logs: string[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-hub-idle-blocked-test-'))
  db = await openAccountsDb(dir)
  orchestrator = createFakeOrchestrator()
  logs = []
})

afterEach(async () => {
  db.handle.close()
  await rm(dir, { recursive: true, force: true })
})

function sweeper(): IdleSweeper {
  return createIdleSweeper({ db, orchestrator, clock: () => NOW_MS, log: (line) => logs.push(line) })
}

function blocked(githubId: number, login: string, install?: { readonly running: boolean }): void {
  insertAccount(db, { githubId, login, subdomain: login, githubCreatedAt: '2019-01-01T00:00:00Z', now: CREATED }, 100)
  setStatus(db, githubId, 'blocked')
  if (install !== undefined) orchestrator.addInstall(login, install)
}

describe('a blocked account whose install runs', () => {
  test('is stopped, marked stopped, and logged in one line', async () => {
    blocked(1, 'mallory', { running: true })

    const summary = await sweeper().sweep()

    expect(orchestrator.install('mallory')?.running).toBe(false)
    expect(findAccountByGithubId(db, 1)).toMatchObject({ status: 'blocked', stoppedAt: new Date(NOW_MS).toISOString() })
    expect(logs).toContain('[hub] idle sweep: @mallory (mallory) blocked — install stopped')
    expect(summary.entries).toEqual([{ login: 'mallory', subdomain: 'mallory', outcome: 'stop', idleDays: null, applied: true }])
  })

  test('the next sweep does not look at it again', async () => {
    blocked(1, 'mallory', { running: true })
    const idle = sweeper()
    await idle.sweep()
    const callsAfterFirst = orchestrator.calls().length

    await idle.sweep()

    expect(orchestrator.calls()).toHaveLength(callsAfterFirst)
  })

  test('a dry run only says it would stop it', async () => {
    blocked(1, 'mallory', { running: true })

    const summary = await sweeper().sweep({ dryRun: true })

    expect(orchestrator.install('mallory')?.running).toBe(true)
    expect(findAccountByGithubId(db, 1)?.stoppedAt).toBeNull()
    expect(logs).toContain('[hub] idle sweep (dry run): @mallory (mallory) blocked — install would be stopped')
    expect(summary.entries[0]).toMatchObject({ outcome: 'stop', applied: false })
  })

  test('a failed stop is logged and tried again on the next sweep', async () => {
    blocked(1, 'mallory', { running: true })
    orchestrator.fail('stop')
    const idle = sweeper()

    const first = await idle.sweep()
    orchestrator.succeed('stop')
    await idle.sweep()

    expect(first.entries[0]).toMatchObject({ outcome: 'failed' })
    expect(logs.some((entry) => entry.startsWith('[hub] idle sweep: @mallory (mallory) failed, will try again next sweep:'))).toBe(true)
    expect(orchestrator.install('mallory')?.running).toBe(false)
  })
})

describe('a blocked account whose install does not run', () => {
  test('an install already stopped is marked, not stopped again', async () => {
    blocked(1, 'mallory', { running: false })

    await sweeper().sweep()

    expect(orchestrator.calls()).toEqual([{ method: 'inspect', subdomain: 'mallory' }])
    expect(findAccountByGithubId(db, 1)?.stoppedAt).toBe(new Date(NOW_MS).toISOString())
    expect(logs).toContain('[hub] idle sweep: @mallory (mallory) blocked — install already stopped')
  })

  test('no install at all is logged and left for the operator', async () => {
    blocked(1, 'mallory')

    const summary = await sweeper().sweep()

    expect(findAccountByGithubId(db, 1)?.stoppedAt).toBeNull()
    expect(logs).toContain('[hub] idle sweep: @mallory (mallory) blocked — no install')
    expect(summary.entries[0]).toMatchObject({ outcome: 'keep', applied: false })
  })
})
