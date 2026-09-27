import type { DatabaseSync } from 'node:sqlite'
import type { AccountsDb } from './accounts-db.js'
import { ACCOUNT_COLUMNS, accountRecordOf, type AccountRecord } from './account-row.js'

/**
 * What `hub.db` keeps about idle installs (plan `hosted-path-and-ops`,
 * Task C, P6/P8): when the idle sweeper stopped an account's install, and the
 * writes that go with stopping, starting and removing it.
 *
 * `stopped_at` is added by `ALTER TABLE … ADD COLUMN` rather than by
 * rebuilding the table: SQLite cannot change a CHECK constraint in place, and
 * the column needs none (P8). The same `ensureIdleColumns` runs on every open,
 * so a fresh database and one from before the column are the same shape.
 *
 * Every write is bound to the row it was decided on — the GitHub id AND the
 * row's `created_at`, as a session is (`sessions.ts`) — so a decision made
 * about one account never lands on a later account of the same person. Every
 * value reaches SQLite through a `?` placeholder.
 */

/** Which account row a write is for. */
export interface AccountKey {
  readonly githubId: number
  readonly createdAt: string
}

const TABLE_INFO = 'PRAGMA table_info(accounts)'
const ADD_STOPPED_AT = 'ALTER TABLE accounts ADD COLUMN stopped_at TEXT'
const MARK_STOPPED =
  "UPDATE accounts SET stopped_at = ? WHERE github_id = ? AND created_at = ? AND status = 'active' AND stopped_at IS NULL"
const MARK_STARTED = 'UPDATE accounts SET stopped_at = NULL WHERE github_id = ? AND created_at = ? AND stopped_at IS NOT NULL'
const MARK_STARTED_AND_SEEN =
  'UPDATE accounts SET stopped_at = NULL, last_seen_at = ? WHERE github_id = ? AND created_at = ? AND stopped_at IS NOT NULL'
const MARK_STOPPED_WHILE_BLOCKED =
  "UPDATE accounts SET stopped_at = ? WHERE github_id = ? AND created_at = ? AND status = 'blocked' AND stopped_at IS NULL"
const SELECT_BLOCKED_UNSTOPPED = `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE status = 'blocked' AND stopped_at IS NULL ORDER BY created_at, github_id`
const SELECT_ACTIVE = `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE status = 'active' ORDER BY created_at, github_id`
const DELETE_IDLE = "DELETE FROM accounts WHERE github_id = ? AND created_at = ? AND status = 'active'"

/** Adds `stopped_at` to an `accounts` table that lacks it; a no-op otherwise. */
export function ensureIdleColumns(database: DatabaseSync): void {
  const columns = database.prepare(TABLE_INFO).all() as ReadonlyArray<{ readonly name?: unknown }>
  if (!columns.some((column) => column.name === 'stopped_at')) database.exec(ADD_STOPPED_AT)
}

/** Records that the account's install was stopped at `at`; only an active account not already marked. */
export function markStopped(db: AccountsDb, key: AccountKey, at: string): boolean {
  return changedOne(db.handle.db.prepare(MARK_STOPPED).run(at, key.githubId, key.createdAt))
}

/**
 * Clears the stop mark once the install runs again. With `seenAt` — a start
 * its person asked for by signing in or opening `/account` — it also counts
 * as seeing them, so the next sweep does not stop the install straight away.
 */
export function markStarted(db: AccountsDb, key: AccountKey, seenAt?: string): boolean {
  const statement = db.handle.db.prepare(seenAt === undefined ? MARK_STARTED : MARK_STARTED_AND_SEEN)
  const result = seenAt === undefined ? statement.run(key.githubId, key.createdAt) : statement.run(seenAt, key.githubId, key.createdAt)
  return changedOne(result)
}

/**
 * Records that a blocked account's install is stopped (stage-4 review): the
 * mark is what lets its person's next sign-in after an `unblock` start it
 * again (`install-waker.ts` starts only a marked install). Only a blocked row
 * of this generation not already marked.
 */
export function markStoppedWhileBlocked(db: AccountsDb, key: AccountKey, at: string): boolean {
  return changedOne(db.handle.db.prepare(MARK_STOPPED_WHILE_BLOCKED).run(at, key.githubId, key.createdAt))
}

/** Every `active` account, oldest first: what one sweep decides idleness for. */
export function listActiveForSweep(db: AccountsDb): readonly AccountRecord[] {
  return recordsOf(db.handle.db.prepare(SELECT_ACTIVE).all())
}

/** Every `blocked` account not yet known stopped, oldest first: one sweep stops their installs. */
export function listBlockedForSweep(db: AccountsDb): readonly AccountRecord[] {
  return recordsOf(db.handle.db.prepare(SELECT_BLOCKED_UNSTOPPED).all())
}

function recordsOf(rows: readonly unknown[]): readonly AccountRecord[] {
  return rows.map(accountRecordOf).filter((record): record is AccountRecord => record !== null)
}

/**
 * Removes an account whose install the sweeper removed after 90 idle days
 * (P6) — with NO tombstone: nobody deleted or blocked it, so the person may
 * sign up again at once and gets a fresh install.
 */
export function deleteIdleAccount(db: AccountsDb, key: AccountKey): boolean {
  return changedOne(db.handle.db.prepare(DELETE_IDLE).run(key.githubId, key.createdAt))
}

function changedOne(result: { readonly changes: number | bigint }): boolean {
  return Number(result.changes) === 1
}
