import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  findAccountByGithubId,
  insertAccount,
  openAccountsDb,
  setStatus,
  type AccountRecord,
  type AccountsDb,
} from '../../hub/src/accounts-db.js'
import { unavailableOrchestrator, type Orchestrator } from '../../hub/src/orchestrator.js'
import { createPendingTokens, type PendingTokens } from '../../hub/src/pending-tokens.js'
import { createProvisioning, type Provisioning } from '../../hub/src/provisioning.js'
import { createFakeOrchestrator, type FakeOrchestrator } from './fake-orchestrator.js'

/**
 * `hub/src/provisioning.ts` (plan `hosted-path-and-ops`, Task A, P1–P4): the
 * install is created in the background — success activates the account and
 * leaves the owner token in memory, failure removes the pending row and
 * leaves a failure mark — and at start every `pending` row left by an
 * earlier run is settled against the provisioner.
 */

const NOW = '2026-09-27T10:00:00.000Z'

let dir: string
let db: AccountsDb
let orchestrator: FakeOrchestrator
let pending: PendingTokens
let logs: string[]
let provisioning: Provisioning

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-hub-provisioning-test-'))
  db = await openAccountsDb(dir)
  orchestrator = createFakeOrchestrator()
  pending = createPendingTokens()
  logs = []
  provisioning = build(orchestrator)
})

afterEach(async () => {
  db.handle.close()
  await rm(dir, { recursive: true, force: true })
})

function build(using: Orchestrator): Provisioning {
  return createProvisioning({ db, orchestrator: using, pending, log: (line) => logs.push(line) })
}

function reserve(githubId: number, login: string): AccountRecord {
  const inserted = insertAccount(db, { githubId, login, subdomain: login, githubCreatedAt: '2019-01-01T00:00:00Z', now: NOW }, 100)
  if (!inserted.ok) throw new Error(`could not seed ${login}: ${inserted.reason}`)
  return inserted.account
}

function keyOf(account: AccountRecord): { githubId: number; accountCreatedAt: string } {
  return { githubId: account.githubId, accountCreatedAt: account.createdAt }
}

describe('start', () => {
  test('success activates the account and leaves the token for one take, never in a log', async () => {
    const account = reserve(1, 'alice')

    expect(provisioning.start(account)).toBe(true)
    await provisioning.settled()

    expect(findAccountByGithubId(db, 1)?.status).toBe('active')
    const [token] = orchestrator.tokens()
    expect(pending.takeToken(keyOf(account))).toBe(token)
    expect(logs.join('\n')).toContain('install ready: @alice -> alice')
    expect(logs.join('\n')).not.toContain(String(token))
  })

  test('returns at once while the create is still running', async () => {
    orchestrator.hold('create')
    const account = reserve(1, 'alice')

    provisioning.start(account)

    expect(provisioning.isRunning(1)).toBe(true)
    expect(findAccountByGithubId(db, 1)?.status).toBe('pending')
    orchestrator.release('create')
    await provisioning.settled()
    expect(provisioning.isRunning(1)).toBe(false)
  })

  test('a second start for the same account while one runs starts nothing', async () => {
    orchestrator.hold('create')
    const account = reserve(1, 'alice')

    expect(provisioning.start(account)).toBe(true)
    expect(provisioning.start(account)).toBe(false)
    orchestrator.release('create')
    await provisioning.settled()

    expect(orchestrator.calls()).toEqual([{ method: 'create', subdomain: 'alice' }])
  })

  test('failure removes the pending row, leaves a failure mark, and logs a redacted reason', async () => {
    orchestrator.fail('create', 'upstream said mcpo_leakedToken0123456789 no')
    const account = reserve(1, 'alice')

    provisioning.start(account)
    await provisioning.settled()

    expect(findAccountByGithubId(db, 1)).toBeNull()
    expect(pending.takeFailed(keyOf(account))).toBe(true)
    const logged = logs.join('\n')
    expect(logged).toContain('install creation failed for alice, signup rolled back')
    expect(logged).toContain('[redacted]')
    expect(logged).not.toContain('mcpo_leakedToken0123456789')
  })

  test('an account blocked while its install was being made is not re-activated, and its token is dropped', async () => {
    orchestrator.hold('create')
    const account = reserve(1, 'alice')
    provisioning.start(account)

    setStatus(db, 1, 'blocked')
    orchestrator.release('create')
    await provisioning.settled()

    expect(findAccountByGithubId(db, 1)?.status).toBe('blocked')
    expect(pending.takeToken(keyOf(account))).toBeUndefined()
    expect(logs.join('\n')).toContain('no longer pending')
  })

  test('after stop a failed create leaves the row pending for the next start', async () => {
    orchestrator.hold('create')
    orchestrator.fail('create', 'socket destroyed by shutdown')
    const account = reserve(1, 'alice')
    provisioning.start(account)

    provisioning.stop()
    orchestrator.release('create')
    await provisioning.settled()

    expect(findAccountByGithubId(db, 1)?.status).toBe('pending')
    expect(pending.takeFailed(keyOf(account))).toBe(false)
    expect(logs.join('\n')).toContain('left pending')
  })

  test('after stop nothing new starts', () => {
    provisioning.stop()

    expect(provisioning.start(reserve(1, 'alice'))).toBe(false)
    expect(orchestrator.calls()).toEqual([])
  })

  test('a database that fails under the task is logged, never an unhandled rejection', async () => {
    orchestrator.hold('create')
    const account = reserve(1, 'alice')
    provisioning.start(account)

    db.handle.close()
    orchestrator.release('create')
    await provisioning.settled()
    db = await openAccountsDb(dir)

    expect(logs.join('\n')).toContain('install task for alice failed')
    expect(findAccountByGithubId(db, 1)?.status).toBe('pending')
  })
})

describe('reconcilePending (P4)', () => {
  test('an install that exists activates its account; one that does not removes the row', async () => {
    reserve(1, 'alice')
    reserve(2, 'bob')
    orchestrator.addInstall('alice')

    const summary = await provisioning.reconcilePending()

    expect(summary).toEqual({ activated: 1, discarded: 1, leftPending: 0 })
    expect(findAccountByGithubId(db, 1)?.status).toBe('active')
    expect(findAccountByGithubId(db, 2)).toBeNull()
    expect(orchestrator.calls()).toEqual([
      { method: 'inspect', subdomain: 'alice' },
      { method: 'inspect', subdomain: 'bob' },
    ])
  })

  test('a provisioner that cannot answer leaves the row pending and says so', async () => {
    reserve(1, 'alice')
    orchestrator.fail('inspect', 'connect ECONNREFUSED')

    const summary = await provisioning.reconcilePending()

    expect(summary).toEqual({ activated: 0, discarded: 0, leftPending: 1 })
    expect(findAccountByGithubId(db, 1)?.status).toBe('pending')
    expect(logs.join('\n')).toContain('install status for alice unknown, left pending')
  })

  test('active and blocked accounts are not asked about', async () => {
    reserve(1, 'alice')
    setStatus(db, 1, 'active')
    reserve(2, 'bob')
    setStatus(db, 2, 'blocked')

    expect(await provisioning.reconcilePending()).toEqual({ activated: 0, discarded: 0, leftPending: 0 })
    expect(orchestrator.calls()).toEqual([])
  })

  test('an account whose create is running right now is left to its task', async () => {
    orchestrator.hold('create')
    provisioning.start(reserve(1, 'alice'))

    expect(await provisioning.reconcilePending()).toEqual({ activated: 0, discarded: 0, leftPending: 1 })
    expect(orchestrator.calls().filter((call) => call.method === 'inspect')).toEqual([])
    orchestrator.release('create')
    await provisioning.settled()
  })

  test('without an available orchestrator nothing is asked and nothing changes', async () => {
    reserve(1, 'alice')
    const idle = build(unavailableOrchestrator)

    expect(await idle.reconcilePending()).toEqual({ activated: 0, discarded: 0, leftPending: 1 })
    expect(findAccountByGithubId(db, 1)?.status).toBe('pending')
  })

  test('a database that fails under it is logged and resolves, never an unhandled rejection', async () => {
    reserve(1, 'alice')
    db.handle.close()

    const summary = await provisioning.reconcilePending()
    db = await openAccountsDb(dir)

    expect(summary).toEqual({ activated: 0, discarded: 0, leftPending: 0 })
    expect(logs.join('\n')).toContain('pending accounts could not be settled')
    await provisioning.settled()
  })

  test('settled waits for a running reconcile', async () => {
    reserve(1, 'alice')
    orchestrator.addInstall('alice')
    orchestrator.hold('inspect')

    const running = provisioning.reconcilePending()
    const settled = provisioning.settled()
    orchestrator.release('inspect')
    await settled

    expect(findAccountByGithubId(db, 1)?.status).toBe('active')
    await running
  })
})
