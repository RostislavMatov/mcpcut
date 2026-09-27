import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  activatePendingAccount,
  blockActiveAccount,
  countWaitlist,
  discardPendingAccount,
  findAccountByGithubId,
  findAccountByLogin,
  findTombstone,
  insertAccount,
  joinWaitlist,
  listAccounts,
  openAccountsDb,
  setStatus,
  type AccountsDb,
} from '../../hub/src/accounts-db.js'

/**
 * The operator-facing and rollback reads/writes `hub/src/accounts-db.ts`
 * grew for Task 5: `list`, `block <login>`, the pending-row rollback when the
 * orchestrator fails, and the waitlist size `list` prints.
 */

const NOW = '2026-09-27T10:00:00.000Z'
const MAX = 15

let dir: string
let db: AccountsDb

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-hub-accounts-op-test-'))
  db = await openAccountsDb(dir)
})

afterEach(async () => {
  db.handle.close()
  await rm(dir, { recursive: true, force: true })
})

function seed(githubId: number, login: string): void {
  const result = insertAccount(
    db,
    { githubId, login, subdomain: login.toLowerCase(), githubCreatedAt: '2019-01-01T00:00:00Z', now: NOW },
    MAX,
  )
  expect(result.ok).toBe(true)
}

describe('listAccounts', () => {
  test('returns every account ordered by creation, then id', () => {
    seed(2, 'bob')
    seed(1, 'alice')

    const logins = listAccounts(db).map((account) => account.login)

    expect(logins).toEqual(['alice', 'bob'])
  })

  test('is empty on a fresh database', () => {
    expect(listAccounts(db)).toEqual([])
  })
})

describe('findAccountByLogin', () => {
  test('matches case-insensitively, as GitHub logins do', () => {
    seed(7, 'Alice')

    expect(findAccountByLogin(db, 'alice')?.githubId).toBe(7)
    expect(findAccountByLogin(db, 'ALICE')?.githubId).toBe(7)
  })

  test('returns null for an unknown login', () => {
    expect(findAccountByLogin(db, 'nobody')).toBeNull()
  })
})

describe('discardPendingAccount', () => {
  test('removes a pending row without writing a tombstone', () => {
    seed(3, 'carol')

    expect(discardPendingAccount(db, 3)).toBe(true)

    expect(findAccountByGithubId(db, 3)).toBeNull()
    expect(findTombstone(db, 3)).toBeNull()
  })

  test('never touches an active row', () => {
    seed(4, 'dave')
    setStatus(db, 4, 'active')

    expect(discardPendingAccount(db, 4)).toBe(false)

    expect(findAccountByGithubId(db, 4)?.status).toBe('active')
  })
})

describe('activatePendingAccount', () => {
  test('turns the pending row of exactly this account generation active', () => {
    seed(5, 'erin')

    expect(activatePendingAccount(db, 5, '2026-01-01T00:00:00.000Z')).toBe(false)
    expect(activatePendingAccount(db, 5, NOW)).toBe(true)

    expect(findAccountByGithubId(db, 5)?.status).toBe('active')
  })

  test('never un-blocks a row blocked meanwhile', () => {
    seed(6, 'fay')
    setStatus(db, 6, 'blocked')

    expect(activatePendingAccount(db, 6, NOW)).toBe(false)

    expect(findAccountByGithubId(db, 6)?.status).toBe('blocked')
  })
})

describe('blockActiveAccount', () => {
  test('blocks the active row of exactly this account generation', () => {
    seed(7, 'gus')
    setStatus(db, 7, 'active')

    expect(blockActiveAccount(db, 7, '2026-01-01T00:00:00.000Z')).toBe(false)
    expect(blockActiveAccount(db, 7, NOW)).toBe(true)

    expect(findAccountByGithubId(db, 7)?.status).toBe('blocked')
  })

  test('never blocks a row still being created (pending)', () => {
    seed(8, 'hal')

    expect(blockActiveAccount(db, 8, NOW)).toBe(false)

    expect(findAccountByGithubId(db, 8)?.status).toBe('pending')
  })
})

describe('countWaitlist', () => {
  test('counts distinct people waiting', () => {
    joinWaitlist(db, { githubId: 10, login: 'x', now: NOW })
    joinWaitlist(db, { githubId: 11, login: 'y', now: NOW })
    joinWaitlist(db, { githubId: 10, login: 'x2', now: NOW })

    expect(countWaitlist(db)).toBe(2)
  })
})
