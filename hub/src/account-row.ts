/**
 * One row of `accounts` as the hub reads it (plan `hub-signin-accounts`,
 * Task 2, H3; `stopped_at` from plan `hosted-path-and-ops`, P6/P8): the
 * column list every account SELECT uses and the one validating mapper from a
 * raw row, shared by `accounts-db.ts` and `accounts-idle.ts` so the two can
 * never read an account differently.
 */

export type AccountStatus = 'pending' | 'active' | 'blocked'

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
  /** Last successful sign-in (or start of a stopped install by its person); refreshed by `touch`. */
  readonly lastSeenAt: string
  /** When the idle sweeper stopped the install (P6); `null` while it runs. */
  readonly stoppedAt: string | null
}

/** The columns, in `accountRecordOf`'s order, for `SELECT ${ACCOUNT_COLUMNS} FROM accounts …`. */
export const ACCOUNT_COLUMNS =
  'github_id, login, subdomain, status, github_created_at, created_at, last_seen_at, stopped_at'

/** A validated `AccountRecord`, or `null` for a row that is not one. */
export function accountRecordOf(row: unknown): AccountRecord | null {
  if (typeof row !== 'object' || row === null) return null
  const {
    github_id: githubId,
    login,
    subdomain,
    status,
    github_created_at: githubCreatedAt,
    created_at: createdAt,
    last_seen_at: lastSeenAt,
    stopped_at: stoppedAt,
  } = row as Record<string, unknown>
  if (typeof githubId !== 'number' && typeof githubId !== 'bigint') return null
  if (typeof login !== 'string' || typeof subdomain !== 'string') return null
  if (status !== 'pending' && status !== 'active' && status !== 'blocked') return null
  if (typeof githubCreatedAt !== 'string' || typeof createdAt !== 'string') return null
  if (typeof lastSeenAt !== 'string') return null
  if (stoppedAt !== null && stoppedAt !== undefined && typeof stoppedAt !== 'string') return null
  return {
    githubId: Number(githubId),
    login,
    subdomain,
    status,
    githubCreatedAt,
    createdAt,
    lastSeenAt,
    stoppedAt: typeof stoppedAt === 'string' ? stoppedAt : null,
  }
}
