import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openSqlite, type SqliteHandle } from '../../src/store/sqlite.js'

/**
 * Storage for the hub's own state (plan `hub-signin-accounts`, Task 2, H3):
 * accounts, the waitlist and delete/block tombstones, all in one `hub.db` —
 * a SEPARATE database from any install's `state.db`/`journal.db`, because the
 * hub is not an install (ADR-0017 phase 2). `openSqlite` is the same single
 * point of contact with `node:sqlite` every install store uses
 * (`src/store/sqlite.ts`, ADR-0006); the schema and every statement below are
 * the hub's own, mirroring the STRICT-table style of
 * `src/policy/approvals/queue-db.ts` rather than importing it (that module
 * pulls in `store-backend.ts`, which is not on the H1 allowlist).
 *
 * Every value below reaches SQLite through a `?` placeholder — never string
 * concatenation — matching CLAUDE.md's SQL-injection rule.
 */

export type AccountStatus = 'pending' | 'active' | 'blocked'
export type TombstoneReason = 'deleted' | 'blocked'

/** One row of `accounts`, keyed by the GitHub numeric id (H3: never `login`,
 * which can change hands). */
export interface AccountRecord {
  readonly githubId: number
  readonly login: string
  readonly subdomain: string
  readonly status: AccountStatus
  /** The GitHub account's own `created_at`, used by the age gate (HA12). */
  readonly githubCreatedAt: string
  /** When this hub first saw the account. */
  readonly createdAt: string
  /** Last successful sign-in; refreshed by `touch`. */
  readonly lastSeenAt: string
}

/** One row of `tombstones`: why a GitHub id is refused re-signup, and since when. */
export interface TombstoneRecord {
  readonly githubId: number
  readonly reason: TombstoneReason
  readonly at: string
}

export interface AccountsDb {
  readonly handle: SqliteHandle
  readonly dbPath: string
}

const CREATE_ACCOUNTS_TABLE =
  'CREATE TABLE IF NOT EXISTS accounts (' +
  'github_id INTEGER PRIMARY KEY, login TEXT NOT NULL, subdomain TEXT NOT NULL UNIQUE, ' +
  "status TEXT NOT NULL CHECK (status IN ('pending','active','blocked')), " +
  'github_created_at TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL) STRICT'

const CREATE_WAITLIST_TABLE =
  'CREATE TABLE IF NOT EXISTS waitlist (' +
  'github_id INTEGER PRIMARY KEY, login TEXT NOT NULL, joined_at TEXT NOT NULL) STRICT'

const CREATE_TOMBSTONES_TABLE =
  'CREATE TABLE IF NOT EXISTS tombstones (' +
  'github_id INTEGER PRIMARY KEY, ' +
  "reason TEXT NOT NULL CHECK (reason IN ('deleted','blocked')), at TEXT NOT NULL) STRICT"

/** Serves `joinWaitlist`'s position query (ordered by arrival, ties broken by id). */
const CREATE_WAITLIST_ORDER_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_waitlist_joined ON waitlist(joined_at, github_id)'
/** Serves `purgeTombstones`'s sweep of expired `'deleted'` rows. */
const CREATE_TOMBSTONES_REASON_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_tombstones_reason_at ON tombstones(reason, at)'

const SELECT_ACCOUNT_BY_ID =
  'SELECT github_id, login, subdomain, status, github_created_at, created_at, last_seen_at ' +
  'FROM accounts WHERE github_id = ?'
const SELECT_ACCOUNT_BY_SUBDOMAIN =
  'SELECT github_id, login, subdomain, status, github_created_at, created_at, last_seen_at ' +
  'FROM accounts WHERE subdomain = ?'
const COUNT_ACCOUNTS = 'SELECT COUNT(*) AS n FROM accounts'
const INSERT_ACCOUNT =
  'INSERT INTO accounts (github_id, login, subdomain, status, github_created_at, created_at, last_seen_at) ' +
  "VALUES (?, ?, ?, 'pending', ?, ?, ?)"
const UPDATE_STATUS = 'UPDATE accounts SET status = ? WHERE github_id = ?'
const TOUCH_ACCOUNT = 'UPDATE accounts SET login = ?, last_seen_at = ? WHERE github_id = ?'
const DELETE_ACCOUNT = 'DELETE FROM accounts WHERE github_id = ?'

const SELECT_ACCOUNT_BY_LOGIN =
  'SELECT github_id, login, subdomain, status, github_created_at, created_at, last_seen_at ' +
  'FROM accounts WHERE lower(login) = lower(?) ORDER BY created_at, github_id LIMIT 1'
const SELECT_ALL_ACCOUNTS =
  'SELECT github_id, login, subdomain, status, github_created_at, created_at, last_seen_at ' +
  'FROM accounts ORDER BY created_at, github_id'
const DELETE_PENDING_ACCOUNT = "DELETE FROM accounts WHERE github_id = ? AND status = 'pending'"
const COUNT_WAITLIST = 'SELECT COUNT(*) AS n FROM waitlist'

const SELECT_TOMBSTONE = 'SELECT github_id, reason, at FROM tombstones WHERE github_id = ?'
/** `'blocked'` tombstones are never purged (HA12's stop-list is permanent);
 * only a `'deleted'` row ages out, and only past the 30-day cooldown. */
const UPSERT_TOMBSTONE =
  'INSERT INTO tombstones (github_id, reason, at) VALUES (?, ?, ?) ' +
  'ON CONFLICT(github_id) DO UPDATE SET reason = excluded.reason, at = excluded.at'
const PURGE_DELETED_TOMBSTONES = "DELETE FROM tombstones WHERE reason = 'deleted' AND at < ?"

const UPSERT_WAITLIST =
  'INSERT INTO waitlist (github_id, login, joined_at) VALUES (?, ?, ?) ' +
  'ON CONFLICT(github_id) DO UPDATE SET login = excluded.login'
/** 1-based rank by arrival order; a row-value comparison so ties (same
 * `joined_at` millisecond) still resolve to a single, stable ordering via
 * the primary key. */
const SELECT_WAITLIST_POSITION =
  'SELECT COUNT(*) AS n FROM waitlist WHERE (joined_at, github_id) <= ' +
  '(SELECT joined_at, github_id FROM waitlist WHERE github_id = ?)'

/** `hub.db` inside the hub's data directory. */
export function accountsDbPath(dataDir: string): string {
  return join(dataDir, 'hub.db')
}

/** Opens (creating if needed) the hub's database and guarantees its schema. */
export async function openAccountsDb(dataDir: string): Promise<AccountsDb> {
  const dbPath = accountsDbPath(dataDir)
  const handle = await openSqlite(dbPath, { synchronous: 'normal' })
  const database = handle.db
  database.exec(CREATE_ACCOUNTS_TABLE)
  database.exec(CREATE_WAITLIST_TABLE)
  database.exec(CREATE_TOMBSTONES_TABLE)
  database.exec(CREATE_WAITLIST_ORDER_INDEX)
  database.exec(CREATE_TOMBSTONES_REASON_INDEX)
  return { handle, dbPath }
}

/** The account keyed by `githubId`, or `null` if none exists. */
export function findAccountByGithubId(db: AccountsDb, githubId: number): AccountRecord | null {
  return accountRecordOf(db.handle.db.prepare(SELECT_ACCOUNT_BY_ID).get(githubId))
}

/** The account currently holding `subdomain`, or `null` if it is free. Used
 * by callers (Task 5) as the `isOccupied` check `subdomain.ts` requires. */
export function findAccountBySubdomain(db: AccountsDb, subdomain: string): AccountRecord | null {
  return accountRecordOf(db.handle.db.prepare(SELECT_ACCOUNT_BY_SUBDOMAIN).get(subdomain))
}

/**
 * How many of the plan's seats are occupied — every row in `accounts`,
 * whatever its `status`. A `'pending'` row is a signup in flight and a
 * `'blocked'` one has not had its install removed (that is a future
 * orchestrator action, plan "NOT Building"), so both still hold a seat;
 * only `deleteAccount` frees one. The name matches the plan's Task 2 spec
 * (`countActive`) even though it is not a `status = 'active'` filter — see
 * `insertAccount`, whose cap check depends on exactly this count including
 * `'pending'` rows, or two concurrent signups at capacity-minus-one could
 * both pass a status-filtered check and jointly exceed the cap.
 */
export function countActive(db: AccountsDb): number {
  return countAccountRows(db.handle.db)
}

function countAccountRows(database: DatabaseSync): number {
  const row = database.prepare(COUNT_ACCOUNTS).get() as { n: number }
  return Number(row.n)
}

export interface InsertAccountInput {
  readonly githubId: number
  readonly login: string
  readonly subdomain: string
  readonly githubCreatedAt: string
  /** Injected "now" (ISO-8601 UTC) — see CLAUDE.md's testing rule on injected clocks. */
  readonly now: string
}

export type InsertAccountResult =
  | { readonly ok: true; readonly account: AccountRecord }
  | { readonly ok: false; readonly reason: 'cap-reached' | 'subdomain-taken' | 'already-exists' }

/**
 * Reserves a seat and inserts a new account with status `'pending'`, atomically
 * checking `maxAccounts` inside the same `BEGIN IMMEDIATE` transaction that
 * writes the row (`src/store/sqlite.ts`'s `transaction()`): two concurrent
 * callers at capacity-minus-one can never both succeed, because the second
 * one's transaction does not start until the first has committed (or rolled
 * back) and its count is already reflected.
 *
 * Callers promote the row to `'active'` with `setStatus` once the orchestrator
 * confirms the install, or delete it (no tombstone — see `deleteAccount`) if
 * the orchestrator fails, so a half-provisioned account never lingers as
 * `'pending'` forever.
 */
export function insertAccount(
  db: AccountsDb,
  input: InsertAccountInput,
  maxAccounts: number,
): InsertAccountResult {
  return db.handle.transaction((database) => {
    if (database.prepare(SELECT_ACCOUNT_BY_ID).get(input.githubId) !== undefined) {
      return { ok: false, reason: 'already-exists' }
    }
    if (countAccountRows(database) >= maxAccounts) {
      return { ok: false, reason: 'cap-reached' }
    }
    try {
      database
        .prepare(INSERT_ACCOUNT)
        .run(input.githubId, input.login, input.subdomain, input.githubCreatedAt, input.now, input.now)
    } catch (error: unknown) {
      if (isUniqueConstraintViolation(error)) return { ok: false, reason: 'subdomain-taken' }
      throw error
    }
    return {
      ok: true,
      account: {
        githubId: input.githubId,
        login: input.login,
        subdomain: input.subdomain,
        status: 'pending',
        githubCreatedAt: input.githubCreatedAt,
        createdAt: input.now,
        lastSeenAt: input.now,
      },
    }
  })
}

/**
 * SQLite's constraint-violation primary result code (`SQLITE_CONSTRAINT`).
 * A `UNIQUE` violation specifically arrives on `errcode` as the EXTENDED code
 * `SQLITE_CONSTRAINT_UNIQUE` (2067 = 19 | (8 << 8)) rather than the bare
 * primary code `src/store/sqlite.ts` reads for busy/corrupt — `& 0xff` pulls
 * the primary code back out regardless of which extended variant fired, so a
 * `NOT NULL` or `CHECK` violation (which cannot happen against this schema,
 * but must not be misread as "subdomain taken" if it somehow did) is
 * distinguished by keeping the low byte comparison, not by matching 2067
 * itself.
 */
const SQLITE_CONSTRAINT_PRIMARY_ERRCODE = 19

function isUniqueConstraintViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('errcode' in error)) return false
  const errcode = (error as { errcode?: unknown }).errcode
  return typeof errcode === 'number' && (errcode & 0xff) === SQLITE_CONSTRAINT_PRIMARY_ERRCODE
}

/** Sets `status` in place. Returns whether a row was found to update — the
 * caller (`cli.ts`'s `block`/`unblock`, Task 5) tells "no such account" from
 * "already in that state" apart. Never touches `tombstones`: a soft block is
 * reversible by `unblock` alone. */
export function setStatus(db: AccountsDb, githubId: number, status: AccountStatus): boolean {
  const result = db.handle.db.prepare(UPDATE_STATUS).run(status, githubId)
  return Number(result.changes) === 1
}

/** Refreshes `login` (GitHub logins change) and `lastSeenAt` on a successful
 * sign-in. Never touches `subdomain`: a returning account keeps its address. */
export function touch(db: AccountsDb, githubId: number, login: string, now: string): boolean {
  const result = db.handle.db.prepare(TOUCH_ACCOUNT).run(login, now, githubId)
  return Number(result.changes) === 1
}

/**
 * Removes the account row and records a tombstone in the same transaction —
 * an account is never "half deleted". `reason` distinguishes a self-service
 * delete (`'deleted'`, HA9: a 30-day cooldown before the same GitHub id may
 * sign up again) from a permanent operator removal of a blocked account
 * (`'blocked'`, HA12: the stop-list entry outlives the row and is never
 * purged). Returns `false`, writing nothing, when no such account exists —
 * "delete an unknown account" must not fabricate a tombstone.
 */
export function deleteAccount(
  db: AccountsDb,
  githubId: number,
  reason: TombstoneReason,
  at: string,
): boolean {
  return db.handle.transaction((database) => {
    const deleted = Number(database.prepare(DELETE_ACCOUNT).run(githubId).changes) === 1
    if (deleted) database.prepare(UPSERT_TOMBSTONE).run(githubId, reason, at)
    return deleted
  })
}

/** Every account, oldest first — the operator's `list` (Task 5). */
export function listAccounts(db: AccountsDb): readonly AccountRecord[] {
  const rows = db.handle.db.prepare(SELECT_ALL_ACCOUNTS).all()
  return rows.map(accountRecordOf).filter((record): record is AccountRecord => record !== null)
}

/** The account whose `login` matches case-insensitively (GitHub logins are),
 * or `null`. For operator commands only: a login is a label, never a key (H3). */
export function findAccountByLogin(db: AccountsDb, login: string): AccountRecord | null {
  return accountRecordOf(db.handle.db.prepare(SELECT_ACCOUNT_BY_LOGIN).get(login))
}

/** Rolls back a signup the orchestrator could not complete: removes the row
 * only while it is still `'pending'`, and writes NO tombstone — nothing was
 * deleted by anyone, so no cooldown applies. */
export function discardPendingAccount(db: AccountsDb, githubId: number): boolean {
  return Number(db.handle.db.prepare(DELETE_PENDING_ACCOUNT).run(githubId).changes) === 1
}

/** How many people are on the waitlist. */
export function countWaitlist(db: AccountsDb): number {
  const row = db.handle.db.prepare(COUNT_WAITLIST).get() as { n: number }
  return Number(row.n)
}

/** The tombstone for `githubId`, or `null` if the id was never deleted or blocked-and-removed. */
export function findTombstone(db: AccountsDb, githubId: number): TombstoneRecord | null {
  return tombstoneRecordOf(db.handle.db.prepare(SELECT_TOMBSTONE).get(githubId))
}

export interface JoinWaitlistInput {
  readonly githubId: number
  readonly login: string
  readonly now: string
}

/**
 * Adds `githubId` to the waitlist, or refreshes its `login` if already on it
 * — `joined_at` never moves once set, so a person who signs in again while
 * waiting keeps their place rather than jumping to the back. Returns the
 * 1-based position, computed in the same transaction as the write so it is
 * never stale by the time it is shown.
 */
export function joinWaitlist(db: AccountsDb, input: JoinWaitlistInput): number {
  return db.handle.transaction((database) => {
    database.prepare(UPSERT_WAITLIST).run(input.githubId, input.login, input.now)
    const row = database.prepare(SELECT_WAITLIST_POSITION).get(input.githubId) as { n: number }
    return Number(row.n)
  })
}

/** Deletes `'deleted'`-reason tombstones settled before `cutoffIso` (an
 * ISO-8601 UTC instant). Returns how many rows went. `'blocked'` tombstones
 * are never touched — see the module doc on `deleteAccount`. */
export function purgeTombstones(db: AccountsDb, cutoffIso: string): number {
  return Number(db.handle.db.prepare(PURGE_DELETED_TOMBSTONES).run(cutoffIso).changes)
}

function accountRecordOf(row: unknown): AccountRecord | null {
  if (typeof row !== 'object' || row === null) return null
  const {
    github_id: githubId,
    login,
    subdomain,
    status,
    github_created_at: githubCreatedAt,
    created_at: createdAt,
    last_seen_at: lastSeenAt,
  } = row as Record<string, unknown>
  if (typeof githubId !== 'number' && typeof githubId !== 'bigint') return null
  if (typeof login !== 'string' || typeof subdomain !== 'string') return null
  if (status !== 'pending' && status !== 'active' && status !== 'blocked') return null
  if (typeof githubCreatedAt !== 'string' || typeof createdAt !== 'string') return null
  if (typeof lastSeenAt !== 'string') return null
  return {
    githubId: Number(githubId),
    login,
    subdomain,
    status,
    githubCreatedAt,
    createdAt,
    lastSeenAt,
  }
}

function tombstoneRecordOf(row: unknown): TombstoneRecord | null {
  if (typeof row !== 'object' || row === null) return null
  const { github_id: githubId, reason, at } = row as Record<string, unknown>
  if (typeof githubId !== 'number' && typeof githubId !== 'bigint') return null
  if (reason !== 'deleted' && reason !== 'blocked') return null
  if (typeof at !== 'string') return null
  return { githubId: Number(githubId), reason, at }
}
