import type { AccountRecord, AccountsDb } from './accounts-db.js'
import { markStarted } from './accounts-idle.js'
import { describeOrchestratorError, type Orchestrator } from './orchestrator.js'

/**
 * Starting an install the idle sweeper stopped, when its person comes back
 * (plan `hosted-path-and-ops`, Task C, P6): signing in to the hub or opening
 * `/account` asks for it, and the answer does not wait — a start is a Docker
 * call and the services take a few seconds more, so `/account` says
 * "stopped — starting…" and refreshes itself until the mark is gone.
 *
 * On success the stop mark is cleared AND the person counts as seen now
 * (`markStarted` with `seenAt`): otherwise the next sweep, finding the same
 * old activity, would stop the install again. On failure the mark stays and
 * the next visit tries again. One start per account at a time; a task never
 * rejects.
 */

export interface InstallWakerDeps {
  readonly db: AccountsDb
  readonly orchestrator: Orchestrator
  readonly clock: () => number
  readonly log: (line: string) => void
}

export interface InstallWaker {
  /**
   * Starts the account's install in the background when it is marked stopped.
   * True when a start is under way (this call's or an earlier one's); false
   * when there is nothing to start or it cannot be started now.
   */
  wake(account: AccountRecord): boolean
  isWaking(githubId: number): boolean
  /** Nothing new starts after this (shutdown). */
  stop(): void
  /** Resolves once no start is running. Never rejects. */
  settled(): Promise<void>
}

export function createInstallWaker(deps: InstallWakerDeps): InstallWaker {
  const running = new Map<number, Promise<void>>()
  let stopping = false

  function wake(account: AccountRecord): boolean {
    // Structural, not by the callers' good behaviour: a blocked (or still
    // pending) account's install stays down whoever asks (phase 4 review, LOW).
    if (account.status !== 'active') return false
    if (account.stoppedAt === null) return false
    if (running.has(account.githubId)) return true
    if (stopping || !deps.orchestrator.available) return false
    const task = start(deps, account).finally(() => running.delete(account.githubId))
    running.set(account.githubId, task)
    return true
  }

  return Object.freeze({
    wake,
    isWaking: (githubId: number) => running.has(githubId),
    stop: () => {
      stopping = true
    },
    settled: async () => {
      while (running.size > 0) await Promise.all([...running.values()])
    },
  })
}

async function start(deps: InstallWakerDeps, account: AccountRecord): Promise<void> {
  try {
    await deps.orchestrator.start(account.subdomain)
    markStarted(deps.db, { githubId: account.githubId, createdAt: account.createdAt }, new Date(deps.clock()).toISOString())
    deps.log(`[hub] stopped install started again for its person: @${account.login} (${account.subdomain})`)
  } catch (error: unknown) {
    deps.log(`[hub] starting the stopped install ${account.subdomain} failed, it stays stopped: ${describeOrchestratorError(error)}`)
  }
}
