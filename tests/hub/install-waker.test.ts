import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { markStopped } from '../../hub/src/accounts-idle.js'
import { findAccountByGithubId, insertAccount, openAccountsDb, setStatus, type AccountRecord, type AccountsDb } from '../../hub/src/accounts-db.js'
import { createInstallWaker, type InstallWaker } from '../../hub/src/install-waker.js'
import { unavailableOrchestrator } from '../../hub/src/orchestrator.js'
import { createFakeOrchestrator, type FakeOrchestrator } from './fake-orchestrator.js'

/**
 * `hub/src/install-waker.ts` (plan `hosted-path-and-ops`, Task C, P6): a
 * stopped install starts again in the background when its person returns;
 * success clears the mark and counts as seeing them, failure keeps the mark
 * for the next visit.
 */

const CREATED = '2026-05-01T00:00:00.000Z'
const NOW_MS = Date.parse('2026-09-27T12:00:00.000Z')

let dir: string
let db: AccountsDb
let orchestrator: FakeOrchestrator
let logs: string[]
let waker: InstallWaker

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-hub-install-waker-test-'))
  db = await openAccountsDb(dir)
  orchestrator = createFakeOrchestrator()
  logs = []
  waker = createInstallWaker({ db, orchestrator, clock: () => NOW_MS, log: (line) => logs.push(line) })
})

afterEach(async () => {
  await waker.settled()
  db.handle.close()
  await rm(dir, { recursive: true, force: true })
})

function stoppedAccount(): AccountRecord {
  const inserted = insertAccount(db, { githubId: 1, login: 'alice', subdomain: 'alice', githubCreatedAt: '2019-01-01T00:00:00Z', now: CREATED }, 100)
  if (!inserted.ok) throw new Error('seed failed')
  setStatus(db, 1, 'active')
  orchestrator.addInstall('alice', { running: false })
  markStopped(db, { githubId: 1, createdAt: CREATED }, '2026-09-01T00:00:00.000Z')
  const record = findAccountByGithubId(db, 1)
  if (record === null) throw new Error('seed failed')
  return record
}

describe('wake', () => {
  test('starts the install, clears the mark and counts the person as seen', async () => {
    const account = stoppedAccount()

    expect(waker.wake(account)).toBe(true)
    await waker.settled()

    expect(orchestrator.install('alice')?.running).toBe(true)
    expect(findAccountByGithubId(db, 1)).toMatchObject({ stoppedAt: null, lastSeenAt: new Date(NOW_MS).toISOString() })
    expect(logs.join('\n')).toContain('stopped install started again for its person: @alice (alice)')
  })

  test('does not hold the caller while the start runs, and starts once for two visits', async () => {
    const account = stoppedAccount()
    orchestrator.hold('start')

    expect(waker.wake(account)).toBe(true)
    expect(waker.wake(account)).toBe(true)
    expect(waker.isWaking(1)).toBe(true)
    expect(findAccountByGithubId(db, 1)?.stoppedAt).not.toBeNull()
    orchestrator.release('start')
    await waker.settled()

    expect(orchestrator.calls().filter((call) => call.method === 'start')).toHaveLength(1)
    expect(waker.isWaking(1)).toBe(false)
  })

  test('a failed start keeps the mark for the next visit', async () => {
    const account = stoppedAccount()
    orchestrator.fail('start', 'provisioner start: the provisioner answered HTTP 502 (docker)')

    waker.wake(account)
    await waker.settled()

    expect(findAccountByGithubId(db, 1)?.stoppedAt).toBe('2026-09-01T00:00:00.000Z')
    expect(logs.join('\n')).toContain('starting the stopped install alice failed, it stays stopped')
  })

  test('nothing to do for a running install, without an orchestrator, or after stop', () => {
    const account = stoppedAccount()

    expect(waker.wake({ ...account, stoppedAt: null })).toBe(false)
    expect(createInstallWaker({ db, orchestrator: unavailableOrchestrator, clock: () => NOW_MS, log: () => undefined }).wake(account)).toBe(false)
    waker.stop()
    expect(waker.wake(account)).toBe(false)
    expect(orchestrator.calls()).toEqual([])
  })

  test('never starts the install of an account that is not active, whoever calls', () => {
    const account = stoppedAccount()

    expect(waker.wake({ ...account, status: 'blocked' })).toBe(false)
    expect(waker.wake({ ...account, status: 'pending' })).toBe(false)
    expect(orchestrator.calls()).toEqual([])
  })
})
