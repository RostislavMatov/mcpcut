import {
  countWaitlist,
  deleteAccount,
  findAccountByLogin,
  listAccounts,
  openAccountsDb,
  purgeTombstones,
  setStatus,
  type AccountRecord,
  type AccountsDb,
} from './accounts-db.js'
import { describeOrchestratorError, type Orchestrator } from './orchestrator.js'
import { DELETE_COOLDOWN_DAYS } from './signup-policy.js'

/**
 * The operator's commands (plan Task 5, H7): run in the host's shell —
 * operator access IS shell access to the host, so these add no new surface.
 * They read only `HUB_DATA_DIR` (never the GitHub secret) and print no token
 * of any kind: the hub holds none.
 *
 * `block` flips the status only; the install stays (removing it is the
 * orchestrator's job — phase 3), and a live web session of that account dies
 * on its next request because `sessions.ts` re-reads the row. `delete`
 * removes the install first when an orchestrator is available and keeps the
 * account if that fails — an account is never half deleted.
 */

export interface OperatorIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly clock: () => number
  readonly orchestrator: Orchestrator
}

export const OPERATOR_COMMANDS: ReadonlySet<string> = new Set(['list', 'block', 'unblock', 'delete', 'purge-tombstones'])
const LOGIN_COMMANDS: ReadonlySet<string> = new Set(['block', 'unblock', 'delete'])
const PENDING_REMOVAL_NOTE = 'install removal pending orchestrator'
const DAY_MS = 24 * 60 * 60 * 1000
const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_USAGE = 2

/** Runs one operator command; `dataDir` is `HUB_DATA_DIR`, already checked non-empty. */
export async function runOperatorCommand(
  command: string,
  args: readonly string[],
  dataDir: string,
  io: OperatorIo,
): Promise<number> {
  const login = args[0]
  if (LOGIN_COMMANDS.has(command) && (login === undefined || login === '')) {
    io.stderr(`usage: ${command} <github-login>\n`)
    return EXIT_USAGE
  }
  const db = await openAccountsDb(dataDir)
  try {
    if (command === 'list') return list(db, io)
    if (command === 'purge-tombstones') return purge(db, io)
    const account = findAccountByLogin(db, login ?? '')
    if (account === null) {
      io.stderr(`hub: no account with login ${login ?? ''}\n`)
      return EXIT_FAILED
    }
    if (command === 'block') return block(db, account, io)
    if (command === 'unblock') return unblock(db, account, io)
    return await remove(db, account, io)
  } finally {
    db.handle.close()
  }
}

function list(db: AccountsDb, io: OperatorIo): number {
  const accounts = listAccounts(db)
  if (accounts.length === 0) io.stdout('no accounts\n')
  else {
    io.stdout('login\tsubdomain\tstatus\tcreated\tlast seen\n')
    for (const a of accounts) io.stdout(`${a.login}\t${a.subdomain}\t${a.status}\t${a.createdAt}\t${a.lastSeenAt}\n`)
  }
  io.stdout(`waitlist: ${countWaitlist(db)}\n`)
  return EXIT_OK
}

function block(db: AccountsDb, account: AccountRecord, io: OperatorIo): number {
  if (account.status === 'blocked') {
    io.stdout(`@${account.login} is already blocked\n`)
    return EXIT_OK
  }
  setStatus(db, account.githubId, 'blocked')
  io.stdout(`blocked @${account.login} (${account.subdomain}); its sessions end on their next request\n`)
  io.stdout(`${PENDING_REMOVAL_NOTE}\n`)
  return EXIT_OK
}

function unblock(db: AccountsDb, account: AccountRecord, io: OperatorIo): number {
  if (account.status !== 'blocked') {
    io.stdout(`@${account.login} is not blocked\n`)
    return EXIT_OK
  }
  setStatus(db, account.githubId, 'active')
  io.stdout(`unblocked @${account.login} (${account.subdomain})\n`)
  return EXIT_OK
}

async function remove(db: AccountsDb, account: AccountRecord, io: OperatorIo): Promise<number> {
  if (io.orchestrator.available) {
    try {
      await io.orchestrator.remove(account.subdomain)
    } catch (error: unknown) {
      io.stderr(`hub: removing the install of @${account.login} failed, account kept: ${describeOrchestratorError(error)}\n`)
      return EXIT_FAILED
    }
  } else {
    io.stdout(`${PENDING_REMOVAL_NOTE}\n`)
  }
  // A blocked account's GitHub id stays refused for good (HA12); a plain
  // delete gets the 30-day cooldown (HA9).
  const reason = account.status === 'blocked' ? 'blocked' : 'deleted'
  deleteAccount(db, account.githubId, reason, new Date(io.clock()).toISOString())
  io.stdout(`deleted @${account.login} (${account.subdomain}); tombstone: ${reason}\n`)
  return EXIT_OK
}

function purge(db: AccountsDb, io: OperatorIo): number {
  const cutoff = new Date(io.clock() - DELETE_COOLDOWN_DAYS * DAY_MS).toISOString()
  const purged = purgeTombstones(db, cutoff)
  io.stdout(`purged ${purged} deleted tombstone(s) older than ${DELETE_COOLDOWN_DAYS} days\n`)
  return EXIT_OK
}
