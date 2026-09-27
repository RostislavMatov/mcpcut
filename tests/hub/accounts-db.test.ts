import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  countActive,
  deleteAccount,
  findAccountByGithubId,
  findAccountBySubdomain,
  findTombstone,
  insertAccount,
  joinWaitlist,
  openAccountsDb,
  purgeTombstones,
  setStatus,
  touch,
  type AccountsDb,
} from '../../hub/src/accounts-db.js'

/**
 * `hub/src/accounts-db.ts` (plan `hub-signin-accounts`, Task 2, H3): the
 * hub's own `hub.db` — accounts, waitlist, tombstones. Every write goes
 * through `openSqlite`'s `BEGIN IMMEDIATE` transaction, so the race test below
 * exercises the exact same atomicity guarantee `queue-db.test.ts` exercises
 * for the approvals queue.
 */

let dir: string
let db: AccountsDb

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-hub-accounts-db-test-'))
  db = await openAccountsDb(dir)
})

afterEach(async () => {
  db.handle.close()
  await rm(dir, { recursive: true, force: true })
})

function accountInput(overrides: Partial<Parameters<typeof insertAccount>[1]> = {}) {
  return {
    githubId: 1,
    login: 'alice',
    subdomain: 'alice',
    githubCreatedAt: '2020-01-01T00:00:00.000Z',
    now: '2026-09-27T00:00:00.000Z',
    ...overrides,
  }
}

describe('schema', () => {
  test('opening twice against the same directory is idempotent', async () => {
    const again = await openAccountsDb(dir)
    expect(again.dbPath).toBe(db.dbPath)
    again.handle.close()
  })
})

describe('insertAccount', () => {
  test('a fresh account is inserted as pending', () => {
    const result = insertAccount(db, accountInput(), 15)
    expect(result).toEqual({
      ok: true,
      account: {
        githubId: 1,
        login: 'alice',
        subdomain: 'alice',
        status: 'pending',
        githubCreatedAt: '2020-01-01T00:00:00.000Z',
        createdAt: '2026-09-27T00:00:00.000Z',
        lastSeenAt: '2026-09-27T00:00:00.000Z',
      },
    })
    expect(findAccountByGithubId(db, 1)).toEqual(result.ok ? result.account : null)
  })

  test('inserting the same github id twice is refused as already-exists', () => {
    insertAccount(db, accountInput(), 15)
    const second = insertAccount(db, accountInput({ login: 'alice2', subdomain: 'alice2' }), 15)
    expect(second).toEqual({ ok: false, reason: 'already-exists' })
  })

  test('a taken subdomain is refused even for a different github id', () => {
    insertAccount(db, accountInput(), 15)
    const second = insertAccount(db, accountInput({ githubId: 2, login: 'bob' }), 15)
    expect(second).toEqual({ ok: false, reason: 'subdomain-taken' })
    expect(findAccountByGithubId(db, 2)).toBeNull()
  })

  test('the cap refuses a new account once it is reached', () => {
    insertAccount(db, accountInput({ githubId: 1, login: 'a1', subdomain: 'a1' }), 1)
    const second = insertAccount(db, accountInput({ githubId: 2, login: 'a2', subdomain: 'a2' }), 1)
    expect(second).toEqual({ ok: false, reason: 'cap-reached' })
  })

  test('a pending row still counts against the cap (a reservation, not a slot freed until deleted)', () => {
    // status stays 'pending' — never promoted — and the cap still refuses a second insert.
    insertAccount(db, accountInput({ githubId: 1, login: 'a1', subdomain: 'a1' }), 1)
    expect(countActive(db)).toBe(1)
    const second = insertAccount(db, accountInput({ githubId: 2, login: 'a2', subdomain: 'a2' }), 1)
    expect(second).toEqual({ ok: false, reason: 'cap-reached' })
  })

  test('race: two inserts at capacity-minus-one, exactly one succeeds', async () => {
    insertAccount(db, accountInput({ githubId: 1, login: 'a1', subdomain: 'a1' }), 2)
    expect(countActive(db)).toBe(1)

    const [first, second] = await Promise.all([
      Promise.resolve(insertAccount(db, accountInput({ githubId: 2, login: 'a2', subdomain: 'a2' }), 2)),
      Promise.resolve(insertAccount(db, accountInput({ githubId: 3, login: 'a3', subdomain: 'a3' }), 2)),
    ])

    const outcomes = [first, second]
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1)
    const loser = first.ok ? second : first
    expect(loser).toEqual({ ok: false, reason: 'cap-reached' })
    expect(countActive(db)).toBe(2)
  })
})

describe('findAccountBySubdomain', () => {
  test('finds the account holding a subdomain', () => {
    insertAccount(db, accountInput(), 15)
    expect(findAccountBySubdomain(db, 'alice')?.githubId).toBe(1)
  })

  test('a free subdomain is null', () => {
    expect(findAccountBySubdomain(db, 'nobody')).toBeNull()
  })
})

describe('setStatus and touch', () => {
  test('setStatus updates status and reports success', () => {
    insertAccount(db, accountInput(), 15)
    expect(setStatus(db, 1, 'active')).toBe(true)
    expect(findAccountByGithubId(db, 1)?.status).toBe('active')
  })

  test('setStatus on an unknown id reports false and changes nothing', () => {
    expect(setStatus(db, 999, 'active')).toBe(false)
  })

  test('touch refreshes login and lastSeenAt but never the subdomain', () => {
    insertAccount(db, accountInput(), 15)
    const changed = touch(db, 1, 'alice-renamed', '2026-10-01T00:00:00.000Z')
    expect(changed).toBe(true)
    const account = findAccountByGithubId(db, 1)
    expect(account?.login).toBe('alice-renamed')
    expect(account?.lastSeenAt).toBe('2026-10-01T00:00:00.000Z')
    expect(account?.subdomain).toBe('alice')
  })

  test('a new login taken by someone else at signup gets its own subdomain (touch never reassigns)', () => {
    // account 1 keeps "alice" forever; a later github id also called "alice"
    // gets a distinct subdomain at insertAccount time (subdomain.ts's job) —
    // touch() on account 1 must never collide with or displace that.
    insertAccount(db, accountInput({ githubId: 1, login: 'alice', subdomain: 'alice' }), 15)
    insertAccount(db, accountInput({ githubId: 2, login: 'alice', subdomain: 'alice-2' }), 15)
    touch(db, 1, 'alice', '2026-10-01T00:00:00.000Z')
    expect(findAccountByGithubId(db, 1)?.subdomain).toBe('alice')
    expect(findAccountByGithubId(db, 2)?.subdomain).toBe('alice-2')
  })
})

describe('deleteAccount', () => {
  test('deleting an existing account removes the row and writes a tombstone', () => {
    insertAccount(db, accountInput(), 15)
    const deleted = deleteAccount(db, 1, 'deleted', '2026-09-27T00:00:00.000Z')
    expect(deleted).toBe(true)
    expect(findAccountByGithubId(db, 1)).toBeNull()
    expect(findTombstone(db, 1)).toEqual({
      githubId: 1,
      reason: 'deleted',
      at: '2026-09-27T00:00:00.000Z',
    })
  })

  test('deleting an unknown account reports false and writes no tombstone', () => {
    const deleted = deleteAccount(db, 999, 'deleted', '2026-09-27T00:00:00.000Z')
    expect(deleted).toBe(false)
    expect(findTombstone(db, 999)).toBeNull()
  })

  test('a delete frees the seat the account held', () => {
    insertAccount(db, accountInput({ githubId: 1, login: 'a1', subdomain: 'a1' }), 1)
    expect(insertAccount(db, accountInput({ githubId: 2, login: 'a2', subdomain: 'a2' }), 1)).toEqual({
      ok: false,
      reason: 'cap-reached',
    })
    deleteAccount(db, 1, 'deleted', '2026-09-27T00:00:00.000Z')
    const result = insertAccount(db, accountInput({ githubId: 2, login: 'a2', subdomain: 'a2' }), 1)
    expect(result.ok).toBe(true)
  })

  test('a permanent (blocked) tombstone overwrites an earlier deleted one for the same id', () => {
    insertAccount(db, accountInput(), 15)
    deleteAccount(db, 1, 'deleted', '2026-09-01T00:00:00.000Z')
    // Re-signup after the cooldown, then get blocked-and-removed later.
    insertAccount(db, accountInput({ now: '2026-10-05T00:00:00.000Z' }), 15)
    deleteAccount(db, 1, 'blocked', '2026-10-06T00:00:00.000Z')
    expect(findTombstone(db, 1)).toEqual({
      githubId: 1,
      reason: 'blocked',
      at: '2026-10-06T00:00:00.000Z',
    })
  })
})

describe('joinWaitlist', () => {
  test('a new entry gets position 1', () => {
    expect(joinWaitlist(db, { githubId: 1, login: 'alice', now: '2026-09-27T00:00:00.000Z' })).toBe(1)
  })

  test('later joiners get later positions', () => {
    joinWaitlist(db, { githubId: 1, login: 'a', now: '2026-09-27T00:00:00.000Z' })
    joinWaitlist(db, { githubId: 2, login: 'b', now: '2026-09-27T00:00:01.000Z' })
    expect(joinWaitlist(db, { githubId: 3, login: 'c', now: '2026-09-27T00:00:02.000Z' })).toBe(3)
  })

  test('joining twice is idempotent: the position does not move', () => {
    joinWaitlist(db, { githubId: 1, login: 'a', now: '2026-09-27T00:00:00.000Z' })
    joinWaitlist(db, { githubId: 2, login: 'b', now: '2026-09-27T00:00:01.000Z' })
    const positionAgain = joinWaitlist(db, { githubId: 1, login: 'a-renamed', now: '2026-09-27T00:00:05.000Z' })
    expect(positionAgain).toBe(1)
  })

  test('re-joining refreshes the login without moving joined_at', () => {
    joinWaitlist(db, { githubId: 1, login: 'a', now: '2026-09-27T00:00:00.000Z' })
    joinWaitlist(db, { githubId: 2, login: 'b', now: '2026-09-27T00:00:01.000Z' })
    joinWaitlist(db, { githubId: 1, login: 'a-renamed', now: '2026-09-27T00:00:05.000Z' })
    const row = db.handle.db
      .prepare('SELECT login, joined_at FROM waitlist WHERE github_id = 1')
      .get() as { login: string; joined_at: string }
    expect(row.login).toBe('a-renamed')
    expect(row.joined_at).toBe('2026-09-27T00:00:00.000Z')
  })
})

describe('purgeTombstones', () => {
  test('a deleted-reason tombstone older than the cutoff is purged', () => {
    insertAccount(db, accountInput(), 15)
    deleteAccount(db, 1, 'deleted', '2026-08-01T00:00:00.000Z')
    const purged = purgeTombstones(db, '2026-09-01T00:00:00.000Z')
    expect(purged).toBe(1)
    expect(findTombstone(db, 1)).toBeNull()
  })

  test('a deleted-reason tombstone at or after the cutoff survives', () => {
    insertAccount(db, accountInput(), 15)
    deleteAccount(db, 1, 'deleted', '2026-09-15T00:00:00.000Z')
    const purged = purgeTombstones(db, '2026-09-01T00:00:00.000Z')
    expect(purged).toBe(0)
    expect(findTombstone(db, 1)).not.toBeNull()
  })

  test('a blocked-reason tombstone is never purged, however old the cutoff', () => {
    insertAccount(db, accountInput(), 15)
    deleteAccount(db, 1, 'blocked', '2020-01-01T00:00:00.000Z')
    const purged = purgeTombstones(db, '2030-01-01T00:00:00.000Z')
    expect(purged).toBe(0)
    expect(findTombstone(db, 1)).not.toBeNull()
  })
})
