import {
  blockActiveAccount,
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
import { markStoppedWhileBlocked } from './accounts-idle.js'
import { createIdleSweeper } from './idle-sweeper.js'
import { describeOrchestratorError, type Orchestrator } from './orchestrator.js'
import { DELETE_COOLDOWN_DAYS } from './signup-policy.js'

/**
 * The operator's commands (plan Task 5, H7): run in the host's shell —
 * operator access IS shell access to the host, so these add no new surface.
 * They read only `HUB_DATA_DIR` (never the GitHub secret) and print no token
 * of any kind: the hub holds none.
 *
 * `block` blocks an `active` account and, with the provisioner link, stops
 * its install (data kept) — an install of a blocked account must not run; a
 * live web session of that account dies on its next request because
 * `sessions.ts` re-reads the row. A `pending` account is refused: its install
 * is still being created and would come up after the block with nobody
 * tracking it. A stop that fails, or a shell without the link, leaves the
 * install to the running hub's idle sweep, which stops every blocked install
 * it finds running. `unblock` starts nothing: its person's next sign-in does
 * (`install-waker.ts`), or the operator. `delete`
 * removes the install first when an orchestrator is available and keeps the
 * account if that fails — an account is never half deleted. `sweep` runs one
 * idle sweep (plan `hosted-path-and-ops`, Task C) — `--dry-run` only prints
 * the decisions — and leaves `pending` accounts alone: only the running hub
 * knows which of them it is still creating.
 */

export interface OperatorIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly clock: () => number
  readonly orchestrator: Orchestrator
}

export const OPERATOR_COMMANDS: ReadonlySet<string> = new Set(['list', 'block', 'unblock', 'delete', 'purge-tombstones', 'sweep'])
const DRY_RUN_FLAG = '--dry-run'
const LOGIN_COMMANDS: ReadonlySet<string> = new Set(['block', 'unblock', 'delete'])
const PENDING_REMOVAL_NOTE = 'install removal pending orchestrator'
const BEING_CREATED_NOTE = 'account is being created; try again in a minute'
const NO_LINK_STOP_NOTE = "install not stopped: this shell has no provisioner link; the hub's next idle sweep stops it"
const RETRY_STOP_NOTE = "the account is blocked anyway and the hub's next idle sweep tries again"
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
  if (command === 'sweep' && (args.length > 1 || (args.length === 1 && args[0] !== DRY_RUN_FLAG))) {
    io.stderr(`usage: sweep [${DRY_RUN_FLAG}]\n`)
    return EXIT_USAGE
  }
  const db = await openAccountsDb(dataDir)
  try {
    if (command === 'list') return list(db, io)
    if (command === 'purge-tombstones') return purge(db, io)
    if (command === 'sweep') return await sweep(db, args[0] === DRY_RUN_FLAG, io)
    const account = findAccountByLogin(db, login ?? '')
    if (account === null) {
      io.stderr(`hub: no account with login ${login ?? ''}\n`)
      return EXIT_FAILED
    }
    if (command === 'block') return await block(db, account, io)
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
    io.stdout('login\tsubdomain\tstatus\tcreated\tlast seen\tstopped\n')
    for (const a of accounts) io.stdout(`${a.login}\t${a.subdomain}\t${a.status}\t${a.createdAt}\t${a.lastSeenAt}\t${a.stoppedAt ?? '-'}\n`)
  }
  io.stdout(`waitlist: ${countWaitlist(db)}\n`)
  return EXIT_OK
}

async function block(db: AccountsDb, account: AccountRecord, io: OperatorIo): Promise<number> {
  if (account.status === 'blocked') {
    io.stdout(`@${account.login} is already blocked\n`)
    return EXIT_OK
  }
  if (account.status === 'pending') {
    io.stderr(`hub: @${account.login}: ${BEING_CREATED_NOTE}\n`)
    return EXIT_FAILED
  }
  if (!blockActiveAccount(db, account.githubId, account.createdAt)) {
    io.stderr(`hub: @${account.login} changed while being blocked; run list and try again\n`)
    return EXIT_FAILED
  }
  io.stdout(`blocked @${account.login} (${account.subdomain}); its sessions end on their next request\n`)
  if (!io.orchestrator.available) {
    io.stdout(`${NO_LINK_STOP_NOTE}\n`)
    return EXIT_OK
  }
  try {
    await io.orchestrator.stop(account.subdomain)
  } catch (error: unknown) {
    io.stderr(`hub: warning: stopping the install of @${account.login} failed; ${RETRY_STOP_NOTE}: ${describeOrchestratorError(error)}\n`)
    return EXIT_OK
  }
  markStoppedWhileBlocked(db, { githubId: account.githubId, createdAt: account.createdAt }, new Date(io.clock()).toISOString())
  io.stdout('install stopped (data kept); unblock does not start it — its next sign-in or the operator does\n')
  return EXIT_OK
}

function unblock(db: AccountsDb, account: AccountRecord, io: OperatorIo): number {
  if (account.status !== 'blocked') {
    io.stdout(`@${account.login} is not blocked\n`)
    return EXIT_OK
  }
  setStatus(db, account.githubId, 'active')
  const startNote = account.stoppedAt === null ? '' : '; its install starts on its next sign-in'
  io.stdout(`unblocked @${account.login} (${account.subdomain})${startNote}\n`)
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

async function sweep(db: AccountsDb, dryRun: boolean, io: OperatorIo): Promise<number> {
  if (!io.orchestrator.available) {
    io.stderr('hub: sweep needs the provisioner (set HUB_PROVISIONER_URL and HUB_PROVISIONER_TOKEN_FILE)\n')
    return EXIT_FAILED
  }
  const sweeper = createIdleSweeper({ db, orchestrator: io.orchestrator, clock: io.clock, log: (line) => io.stdout(`${line}\n`) })
  const { entries } = await sweeper.sweep({ dryRun })
  const note = dryRun ? ' (dry run: nothing changed)' : '; pending accounts are settled by the running hub'
  io.stdout(`${entries.length} account(s) swept${note}\n`)
  return entries.some((entry) => entry.outcome === 'failed') ? EXIT_FAILED : EXIT_OK
}

function purge(db: AccountsDb, io: OperatorIo): number {
  const cutoff = new Date(io.clock() - DELETE_COOLDOWN_DAYS * DAY_MS).toISOString()
  const purged = purgeTombstones(db, cutoff)
  io.stdout(`purged ${purged} deleted tombstone(s) older than ${DELETE_COOLDOWN_DAYS} days\n`)
  return EXIT_OK
}
