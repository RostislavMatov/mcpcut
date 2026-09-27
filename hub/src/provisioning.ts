import {
  activatePendingAccount,
  discardPendingAccount,
  listAccounts,
  type AccountRecord,
  type AccountsDb,
} from './accounts-db.js'
import { describeOrchestratorError, type InstallPresence, type Orchestrator } from './orchestrator.js'
import type { PendingKey, PendingTokens } from './pending-tokens.js'

/**
 * Install creation in the background (plan `hosted-path-and-ops`, Task A,
 * P1–P4). The GitHub callback reserves a `pending` row and hands the account
 * here; the answer goes out at once (a create can take far longer than
 * Cloudflare's 100 s) and `/account` shows how it went:
 *
 *   success → `pending` → `active`, the owner token waits in memory (P2)
 *   failure → the `pending` row is removed, a failure mark waits (P3)
 *
 * One task per account at a time. A task never rejects: whatever fails —
 * the orchestrator, the database under it — is logged and swallowed, and the
 * owner token is never part of a log line.
 *
 * After `stop()` (shutdown) nothing new starts, and a create that fails is
 * NOT rolled back: the failure is most likely the shutdown itself cutting the
 * socket while the provisioner carries on, so the row stays `pending` and the
 * next start settles it against the provisioner (`reconcilePending`, P4).
 */

export interface ProvisioningDeps {
  readonly db: AccountsDb
  readonly orchestrator: Orchestrator
  readonly pending: PendingTokens
  readonly log: (line: string) => void
}

export interface ReconcileSummary {
  readonly activated: number
  readonly discarded: number
  readonly leftPending: number
}

export interface Provisioning {
  /** Starts creating the account's install; false when one is already running or after `stop`. */
  start(account: AccountRecord): boolean
  isRunning(githubId: number): boolean
  /** Settles every `pending` row no task is working on against the provisioner (P4). Never rejects. */
  reconcilePending(): Promise<ReconcileSummary>
  stop(): void
  /** Resolves once no task and no reconcile is running. Never rejects. */
  settled(): Promise<void>
}

const NOTHING_SETTLED: ReconcileSummary = Object.freeze({ activated: 0, discarded: 0, leftPending: 0 })

export function createProvisioning(deps: ProvisioningDeps): Provisioning {
  const running = new Map<number, Promise<void>>()
  const reconciles = new Set<Promise<unknown>>()
  let stopping = false

  function start(account: AccountRecord): boolean {
    if (stopping || running.has(account.githubId)) return false
    const task = provision(deps, account, () => stopping)
      .catch((error: unknown) => deps.log(`[hub] install task for ${account.subdomain} failed: ${describeOrchestratorError(error)}`))
      .finally(() => running.delete(account.githubId))
    running.set(account.githubId, task)
    return true
  }

  function reconcilePending(): Promise<ReconcileSummary> {
    const run = reconcile(deps, (githubId) => running.has(githubId)).catch((error: unknown) => {
      deps.log(`[hub] pending accounts could not be settled: ${describeOrchestratorError(error)}`)
      return NOTHING_SETTLED
    })
    const tracked: Promise<unknown> = run.finally(() => reconciles.delete(tracked))
    reconciles.add(tracked)
    return run
  }

  async function settled(): Promise<void> {
    while (running.size > 0 || reconciles.size > 0) await Promise.all([...running.values(), ...reconciles])
  }

  return Object.freeze({
    start,
    isRunning: (githubId: number) => running.has(githubId),
    reconcilePending,
    stop: () => {
      stopping = true
    },
    settled,
  })
}

function keyOf(account: AccountRecord): PendingKey {
  return { githubId: account.githubId, accountCreatedAt: account.createdAt }
}

async function provision(deps: ProvisioningDeps, account: AccountRecord, isStopping: () => boolean): Promise<void> {
  const { db, log } = deps
  let ownerToken: string
  try {
    ownerToken = (await deps.orchestrator.create({ githubId: account.githubId, login: account.login, subdomain: account.subdomain })).ownerToken
  } catch (error: unknown) {
    if (isStopping()) {
      log(`[hub] install creation for ${account.subdomain} interrupted by shutdown, account left pending: ${describeOrchestratorError(error)}`)
      return
    }
    discardPendingAccount(db, account.githubId)
    deps.pending.markFailed(keyOf(account))
    log(`[hub] install creation failed for ${account.subdomain}, signup rolled back: ${describeOrchestratorError(error)}`)
    return
  }
  if (!activatePendingAccount(db, account.githubId, account.createdAt)) {
    log(`[hub] install ${account.subdomain} was created but its account is no longer pending; install left for the operator`)
    return
  }
  deps.pending.putToken(keyOf(account), ownerToken)
  log(`[hub] install ready: @${account.login} -> ${account.subdomain}`)
}

async function reconcile(deps: ProvisioningDeps, isRunning: (githubId: number) => boolean): Promise<ReconcileSummary> {
  const pendingRows = listAccounts(deps.db).filter((account) => account.status === 'pending')
  const counts = { activated: 0, discarded: 0, leftPending: 0 }
  for (const account of pendingRows) {
    const outcome = deps.orchestrator.available && !isRunning(account.githubId) ? await settleOne(deps, account) : 'left'
    if (outcome === 'activated') counts.activated += 1
    else if (outcome === 'discarded') counts.discarded += 1
    else counts.leftPending += 1
  }
  if (pendingRows.length > 0) {
    deps.log(`[hub] pending accounts settled: ${counts.activated} activated, ${counts.discarded} discarded, ${counts.leftPending} left pending`)
  }
  return counts
}

async function settleOne(deps: ProvisioningDeps, account: AccountRecord): Promise<'activated' | 'discarded' | 'left'> {
  let presence: InstallPresence
  try {
    presence = (await deps.orchestrator.inspect(account.subdomain)).state
  } catch (error: unknown) {
    deps.log(`[hub] install status for ${account.subdomain} unknown, left pending: ${describeOrchestratorError(error)}`)
    return 'left'
  }
  if (presence === 'present') {
    // The owner token of an install found this way was never seen by the hub: its person issues a new one.
    return activatePendingAccount(deps.db, account.githubId, account.createdAt) ? 'activated' : 'left'
  }
  return discardPendingAccount(deps.db, account.githubId) ? 'discarded' : 'left'
}
