import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  deleteIdleAccount,
  listActiveForSweep,
  listBlockedForSweep,
  markStarted,
  markStopped,
  markStoppedWhileBlocked,
} from '../../hub/src/accounts-idle.js'
import {
  accountsDbPath,
  findAccountByGithubId,
  findTombstone,
  insertAccount,
  openAccountsDb,
  setStatus,
  type AccountRecord,
  type AccountsDb,
} from '../../hub/src/accounts-db.js'

/**
 * `hub/src/accounts-idle.ts` (plan `hosted-path-and-ops`, Task C, P6/P8): the
 * `stopped_at` column an older `hub.db` gains on open, and the writes the idle
 * sweeper and a returning person make — each bound to the account row it read
 * (GitHub id AND creation time), so it never lands on a later account.
 */

const CREATED = '2026-07-01T00:00:00.000Z'
const STOPPED = '2026-09-01T00:00:00.000Z'
const LATER = '2026-09-27T10:00:00.000Z'

let dir: string
let db: AccountsDb

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-hub-accounts-idle-test-'))
  db = await openAccountsDb(dir)
})

afterEach(async () => {
  db.handle.close()
  await rm(dir, { recursive: true, force: true })
})

function active(githubId: number, login: string): AccountRecord {
  const inserted = insertAccount(db, { githubId, login, subdomain: login, githubCreatedAt: '2019-01-01T00:00:00Z', now: CREATED }, 100)
  if (!inserted.ok) throw new Error(`could not seed ${login}`)
  setStatus(db, githubId, 'active')
  return { ...inserted.account, status: 'active' }
}

const keyOf = (account: AccountRecord) => ({ githubId: account.githubId, createdAt: account.createdAt })

describe('the stopped_at column (P8)', () => {
  test('a new account has none', () => {
    expect(active(1, 'alice').stoppedAt).toBeNull()
    expect(findAccountByGithubId(db, 1)?.stoppedAt).toBeNull()
  })

  test('an older hub.db without the column gains it on open, and keeps its rows', async () => {
    const oldDir = await mkdtemp(join(tmpdir(), 'mcpcut-hub-accounts-old-'))
    const raw = new DatabaseSync(accountsDbPath(oldDir))
    raw.exec(
      'CREATE TABLE accounts (github_id INTEGER PRIMARY KEY, login TEXT NOT NULL, subdomain TEXT NOT NULL UNIQUE, ' +
        "status TEXT NOT NULL CHECK (status IN ('pending','active','blocked')), " +
        'github_created_at TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL) STRICT',
    )
    raw.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?, ?)').run(7, 'old', 'old', 'active', '2019-01-01T00:00:00Z', CREATED, CREATED)
    raw.close()

    const opened = await openAccountsDb(oldDir)
    try {
      const columns = opened.handle.db.prepare('PRAGMA table_info(accounts)').all() as { name: string }[]
      expect(columns.map((column) => column.name)).toContain('stopped_at')
      expect(findAccountByGithubId(opened, 7)).toMatchObject({ login: 'old', status: 'active', lastSeenAt: CREATED, stoppedAt: null })
    } finally {
      opened.handle.close()
    }
    const again = await openAccountsDb(oldDir)
    const columns = again.handle.db.prepare('PRAGMA table_info(accounts)').all() as { name: string }[]
    expect(columns.filter((column) => column.name === 'stopped_at')).toHaveLength(1)
    again.handle.close()
    await rm(oldDir, { recursive: true, force: true })
  })
})

describe('markStopped / markStarted', () => {
  test('stopped, then started: the mark comes and goes', () => {
    const alice = active(1, 'alice')

    expect(markStopped(db, keyOf(alice), STOPPED)).toBe(true)
    expect(findAccountByGithubId(db, 1)?.stoppedAt).toBe(STOPPED)
    expect(markStarted(db, keyOf(alice))).toBe(true)
    expect(findAccountByGithubId(db, 1)?.stoppedAt).toBeNull()
    expect(findAccountByGithubId(db, 1)?.lastSeenAt).toBe(CREATED)
  })

  test('a start by the person counts as seeing them', () => {
    const alice = active(1, 'alice')
    markStopped(db, keyOf(alice), STOPPED)

    expect(markStarted(db, keyOf(alice), LATER)).toBe(true)
    expect(findAccountByGithubId(db, 1)).toMatchObject({ stoppedAt: null, lastSeenAt: LATER })
  })

  test('the first stop wins; a second stop and a start of a running one change nothing', () => {
    const alice = active(1, 'alice')

    expect(markStarted(db, keyOf(alice), LATER)).toBe(false)
    expect(findAccountByGithubId(db, 1)?.lastSeenAt).toBe(CREATED)
    markStopped(db, keyOf(alice), STOPPED)
    expect(markStopped(db, keyOf(alice), LATER)).toBe(false)
    expect(findAccountByGithubId(db, 1)?.stoppedAt).toBe(STOPPED)
  })

  test('never lands on another account of the same person, nor on a blocked one', () => {
    const alice = active(1, 'alice')
    const stale = { githubId: 1, createdAt: '2020-01-01T00:00:00.000Z' }

    expect(markStopped(db, stale, STOPPED)).toBe(false)
    setStatus(db, 1, 'blocked')
    expect(markStopped(db, keyOf(alice), STOPPED)).toBe(false)
    expect(findAccountByGithubId(db, 1)?.stoppedAt).toBeNull()
  })
})

describe('listActiveForSweep', () => {
  test('active accounts only, oldest first', () => {
    active(2, 'bob')
    active(1, 'alice')
    insertAccount(db, { githubId: 3, login: 'carol', subdomain: 'carol', githubCreatedAt: '2019-01-01T00:00:00Z', now: CREATED }, 100)
    active(4, 'dave')
    setStatus(db, 4, 'blocked')

    expect(listActiveForSweep(db).map((account) => account.login)).toEqual(['alice', 'bob'])
  })
})

describe('blocked accounts (a blocked install must not run)', () => {
  test('listBlockedForSweep: blocked accounts not yet known stopped, oldest first', () => {
    const alice = active(1, 'alice')
    active(2, 'bob')
    active(3, 'carol')
    active(4, 'dave')
    setStatus(db, 2, 'blocked')
    setStatus(db, 1, 'blocked')
    setStatus(db, 4, 'blocked')
    markStoppedWhileBlocked(db, { githubId: 4, createdAt: CREATED }, STOPPED)

    expect(listBlockedForSweep(db).map((account) => account.login)).toEqual(['alice', 'bob'])
    expect(keyOf(alice)).toEqual({ githubId: 1, createdAt: CREATED })
  })

  test('markStoppedWhileBlocked marks only a blocked row of this generation, once', () => {
    const alice = active(1, 'alice')

    expect(markStoppedWhileBlocked(db, keyOf(alice), STOPPED)).toBe(false)
    setStatus(db, 1, 'blocked')
    expect(markStoppedWhileBlocked(db, { githubId: 1, createdAt: LATER }, STOPPED)).toBe(false)
    expect(markStoppedWhileBlocked(db, keyOf(alice), STOPPED)).toBe(true)
    expect(markStoppedWhileBlocked(db, keyOf(alice), LATER)).toBe(false)
    expect(findAccountByGithubId(db, 1)?.stoppedAt).toBe(STOPPED)
  })
})

describe('deleteIdleAccount', () => {
  test('removes the row and writes NO tombstone: the person may sign up again at once', () => {
    const alice = active(1, 'alice')

    expect(deleteIdleAccount(db, keyOf(alice))).toBe(true)
    expect(findAccountByGithubId(db, 1)).toBeNull()
    expect(findTombstone(db, 1)).toBeNull()
  })

  test('only the row it read, and only while it is active', () => {
    const alice = active(1, 'alice')

    expect(deleteIdleAccount(db, { githubId: 1, createdAt: LATER })).toBe(false)
    setStatus(db, 1, 'blocked')
    expect(deleteIdleAccount(db, keyOf(alice))).toBe(false)
    expect(findAccountByGithubId(db, 1)).not.toBeNull()
  })
})
