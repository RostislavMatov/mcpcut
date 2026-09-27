import { findAccountByGithubId, type AccountRecord, type AccountsDb } from './accounts-db.js'
import {
  deleteIdleAccount,
  listActiveForSweep,
  listBlockedForSweep,
  markStarted,
  markStopped,
  markStoppedWhileBlocked,
  type AccountKey,
} from './accounts-idle.js'
import { describeOrchestratorError, type InstallInspection, type Orchestrator } from './orchestrator.js'
import type { ReconcileSummary } from './provisioning.js'

/**
 * Stopping and removing installs nobody uses (plan `hosted-path-and-ops`,
 * Task C, P5/P6; HA9).
 *
 * An install's activity is the later of two things: its person's last sign-in
 * to the hub, and the last time the install wrote its journal or its state —
 * the journal takes a record on every agent call and every admin action, so
 * an install used only by agents is still active. The provisioner reads the
 * second with `stat` in the container, which it can only do while the
 * container runs; for a stopped one the stop itself stands in: the sweeper
 * stopped it only after 60 idle days, so its activity was at most
 * `stoppedAt − 60 d`, and removal never comes early.
 *
 *   ≥ 60 days idle → the container is stopped (`stopped_at` is set)
 *   ≥ 90 days idle → the install is removed and so is the account, with no
 *                    tombstone: the person may sign up again at once
 *
 * One sweep inspects every active account, decides, acts and logs one line
 * per account; a failure on one account is logged and the next is swept.
 * Before a removal the row is read again and decided again, so a sign-in
 * during the sweep saves it. An active account whose install is missing is
 * never removed quietly: it is logged and flagged for its `/account` page.
 * Each sweep of the running hub also settles `pending` accounts again (P4 —
 * a provisioner that was down when the hub started), and stops the install
 * of every blocked account not yet known stopped (stage-4 review): the
 * operator's `block` stops it, but a block from a shell without the
 * provisioner link, a stop that failed, or a block from before that rule
 * leaves it running — and an install of a blocked account must not run.
 */

export const STOP_AFTER_DAYS = 60
export const REMOVE_AFTER_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000
const STOP_AFTER_MS = STOP_AFTER_DAYS * DAY_MS
const REMOVE_AFTER_MS = REMOVE_AFTER_DAYS * DAY_MS
/** `YYYY-MM-DD` of an ISO-8601 instant. */
const DATE_LENGTH = 10

export type IdleDecision = 'keep' | 'stop' | 'remove'

export interface IdleFacts {
  /** The person's last sign-in to the hub. */
  readonly lastSeenAt: string
  /** The install's last journal/state write, when the provisioner could read it. */
  readonly lastActivityAt: string | null
  /** When the sweeper stopped the install; `null` while it runs. */
  readonly stoppedAt: string | null
  readonly now: string
}

/** The latest moment the install is known to have been used, in ms; `NaN` when a timestamp is not one. */
function lastActiveMs(facts: Omit<IdleFacts, 'now'>): number {
  const seen = Date.parse(facts.lastSeenAt)
  const written = facts.lastActivityAt === null ? -Infinity : Date.parse(facts.lastActivityAt)
  const boundByStop = facts.stoppedAt === null ? -Infinity : Date.parse(facts.stoppedAt) - STOP_AFTER_MS
  return Math.max(seen, written, boundByStop)
}

/** Whole days since the install was last used, or `null` when that cannot be told. */
export function idleDaysOf(facts: IdleFacts): number | null {
  const idleMs = Date.parse(facts.now) - lastActiveMs(facts)
  return Number.isFinite(idleMs) ? Math.floor(idleMs / DAY_MS) : null
}

/** What the sweeper does with one install. A timestamp that is not one keeps it. */
export function decideIdle(facts: IdleFacts): IdleDecision {
  const idleMs = Date.parse(facts.now) - lastActiveMs(facts)
  if (!Number.isFinite(idleMs)) return 'keep'
  if (idleMs >= REMOVE_AFTER_MS) return 'remove'
  if (idleMs >= STOP_AFTER_MS && facts.stoppedAt === null) return 'stop'
  return 'keep'
}

/**
 * The dates `/account` shows (P6) from what the hub itself knows — the last
 * sign-in and the stop — as `YYYY-MM-DD`. Agent calls only move them later,
 * so "if unused" is always true of them.
 */
export function idleDeadlines(facts: Pick<IdleFacts, 'lastSeenAt' | 'stoppedAt'>): { readonly stopsOn: string; readonly removedOn: string } {
  const active = lastActiveMs({ ...facts, lastActivityAt: null })
  const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, DATE_LENGTH)
  return { stopsOn: dateOf(active + STOP_AFTER_MS), removedOn: dateOf(active + REMOVE_AFTER_MS) }
}

// ---------------------------------------------------------------------------
// The sweep

export interface IdleSweeperDeps {
  readonly db: AccountsDb
  readonly orchestrator: Orchestrator
  readonly clock: () => number
  /** One line per account per sweep; never a token (the sweep handles none). */
  readonly log: (line: string) => void
  /** Settles `pending` accounts each sweep (the running hub's provisioning); omitted by the operator's command. */
  readonly reconcilePending?: () => Promise<ReconcileSummary>
  /** Accounts whose install is being started again right now: left for the next sweep. */
  readonly isWaking?: (githubId: number) => boolean
}

export type SweepOutcome = IdleDecision | 'missing' | 'skipped' | 'failed'

export interface SweepEntry {
  readonly login: string
  readonly subdomain: string
  readonly outcome: SweepOutcome
  readonly idleDays: number | null
  /** Whether the outcome was carried out (never in a dry run; `keep` changes nothing). */
  readonly applied: boolean
}

export interface SweepSummary {
  readonly entries: readonly SweepEntry[]
  /** How `pending` accounts were settled; absent in a dry run or without a reconcile. */
  readonly pending?: ReconcileSummary
}

export interface SweepOptions {
  /** Decide and log only: nothing is stopped, removed, marked or settled. */
  readonly dryRun?: boolean
}

export interface IdleSweeper {
  /** One sweep over every active account and every blocked one not known stopped. Never rejects; a sweep asked for while one runs joins it. */
  sweep(options?: SweepOptions): Promise<SweepSummary>
  /** Whether the last sweep found this account's install missing (`/account` says so). */
  isMissing(key: AccountKey): boolean
  /** Accounts not yet swept are left alone once this is called (shutdown). */
  stop(): void
  settled(): Promise<void>
}

interface SweepContext {
  readonly deps: IdleSweeperDeps
  readonly dryRun: boolean
  readonly now: string
  readonly missing: Map<number, string>
}

export function createIdleSweeper(deps: IdleSweeperDeps): IdleSweeper {
  /** GitHub id → the `createdAt` of the account row whose install was missing. */
  const missing = new Map<number, string>()
  let running: Promise<SweepSummary> | null = null
  let stopping = false

  async function sweepAll(dryRun: boolean): Promise<SweepSummary> {
    const ctx: SweepContext = { deps, dryRun, now: new Date(deps.clock()).toISOString(), missing }
    const pending = dryRun || deps.reconcilePending === undefined ? undefined : await deps.reconcilePending()
    const entries: SweepEntry[] = []
    for (const account of listActiveForSweep(deps.db)) {
      if (stopping) break
      entries.push(await sweepGuarded(ctx, account, sweepOne))
    }
    for (const account of listBlockedForSweep(deps.db)) {
      if (stopping) break
      entries.push(await sweepGuarded(ctx, account, sweepBlocked))
    }
    return pending === undefined ? { entries } : { entries, pending }
  }

  return Object.freeze({
    sweep: (options: SweepOptions = {}) => {
      running ??= sweepAll(options.dryRun === true)
        .catch((error: unknown) => {
          deps.log(`[hub] idle sweep failed: ${describeOrchestratorError(error)}`)
          return { entries: [] }
        })
        .finally(() => {
          running = null
        })
      return running
    },
    isMissing: (key: AccountKey) => missing.get(key.githubId) === key.createdAt,
    stop: () => {
      stopping = true
    },
    settled: async () => {
      await running
    },
  })
}

type SweepStep = (ctx: SweepContext, account: AccountRecord) => Promise<SweepEntry>

async function sweepGuarded(ctx: SweepContext, account: AccountRecord, step: SweepStep): Promise<SweepEntry> {
  try {
    return await step(ctx, account)
  } catch (error: unknown) {
    ctx.deps.log(`${prefixOf(ctx)} @${account.login} (${account.subdomain}) failed, will try again next sweep: ${describeOrchestratorError(error)}`)
    return { login: account.login, subdomain: account.subdomain, outcome: 'failed', idleDays: null, applied: false }
  }
}

async function sweepOne(ctx: SweepContext, account: AccountRecord): Promise<SweepEntry> {
  const { deps } = ctx
  const entry = (outcome: SweepOutcome, idleDays: number | null, applied: boolean): SweepEntry => ({
    login: account.login,
    subdomain: account.subdomain,
    outcome,
    idleDays,
    applied,
  })
  if (deps.isWaking?.(account.githubId) === true) {
    deps.log(`${prefixOf(ctx)} @${account.login} (${account.subdomain}) — being started again, left for the next sweep`)
    return entry('skipped', null, false)
  }
  const inspection = await deps.orchestrator.inspect(account.subdomain)
  if (inspection.state === 'absent') return missingInstall(ctx, account, entry)
  if (!ctx.dryRun) ctx.missing.delete(account.githubId)
  const facts = factsOf(ctx, account, inspection)
  const decision = decideIdle(facts)
  const idleDays = idleDaysOf(facts)
  if (decision === 'keep' || ctx.dryRun) {
    deps.log(`${prefixOf(ctx)} @${account.login} (${account.subdomain}) idle ${idleDays ?? '?'} d — ${describe(decision, ctx.dryRun)}`)
    return entry(decision, idleDays, false)
  }
  const done = decision === 'stop' ? await stopInstall(ctx, account) : await removeInstall(ctx, account, inspection)
  deps.log(`${prefixOf(ctx)} @${account.login} (${account.subdomain}) idle ${idleDays ?? '?'} d — ${describe(done, false)}`)
  return entry(done, idleDays, done !== 'keep')
}

/**
 * A blocked account's install is stopped and marked stopped — the mark keeps
 * the next sweep off it and lets a sign-in after `unblock` start it again.
 * One found already stopped is only marked; one with no install is logged.
 */
async function sweepBlocked(ctx: SweepContext, account: AccountRecord): Promise<SweepEntry> {
  const entry = (outcome: SweepOutcome, applied: boolean): SweepEntry => ({
    login: account.login,
    subdomain: account.subdomain,
    outcome,
    idleDays: null,
    applied,
  })
  const say = (what: string): void => ctx.deps.log(`${prefixOf(ctx)} @${account.login} (${account.subdomain}) blocked — ${what}`)
  const inspection = await ctx.deps.orchestrator.inspect(account.subdomain)
  if (inspection.state === 'absent') {
    say('no install')
    return entry('keep', false)
  }
  if (!inspection.running) {
    if (!ctx.dryRun) markStoppedWhileBlocked(ctx.deps.db, keyOf(account), ctx.now)
    say('install already stopped')
    return entry('keep', false)
  }
  if (ctx.dryRun) {
    say('install would be stopped')
    return entry('stop', false)
  }
  await ctx.deps.orchestrator.stop(account.subdomain)
  markStoppedWhileBlocked(ctx.deps.db, keyOf(account), ctx.now)
  say('install stopped')
  return entry('stop', true)
}

function missingInstall(ctx: SweepContext, account: AccountRecord, entry: (outcome: SweepOutcome, idleDays: number | null, applied: boolean) => SweepEntry): SweepEntry {
  if (!ctx.dryRun) ctx.missing.set(account.githubId, account.createdAt)
  ctx.deps.log(`${prefixOf(ctx)} @${account.login} (${account.subdomain}) — install missing, account kept for the operator`)
  return entry('missing', null, false)
}

/**
 * The facts the rule decides on. A stop mark on an install found running
 * (started by hand, outside the hub) is stale: it is dropped, and the running
 * install is judged by its own activity.
 */
function factsOf(ctx: SweepContext, account: AccountRecord, inspection: InstallInspection): IdleFacts {
  const staleMark = inspection.running && account.stoppedAt !== null
  if (staleMark && !ctx.dryRun) markStarted(ctx.deps.db, keyOf(account))
  return {
    lastSeenAt: account.lastSeenAt,
    lastActivityAt: inspection.lastActivityAt,
    stoppedAt: staleMark ? null : account.stoppedAt,
    now: ctx.now,
  }
}

async function stopInstall(ctx: SweepContext, account: AccountRecord): Promise<IdleDecision> {
  await ctx.deps.orchestrator.stop(account.subdomain)
  markStopped(ctx.deps.db, keyOf(account), ctx.now)
  return 'stop'
}

/** Decided again on a fresh read first: a sign-in since the sweep began keeps the install. */
async function removeInstall(ctx: SweepContext, account: AccountRecord, inspection: InstallInspection): Promise<IdleDecision> {
  const fresh = findAccountByGithubId(ctx.deps.db, account.githubId)
  if (fresh === null || fresh.createdAt !== account.createdAt || fresh.status !== 'active') return 'keep'
  if (decideIdle(factsOf({ ...ctx, dryRun: true }, fresh, inspection)) !== 'remove') return 'keep'
  await ctx.deps.orchestrator.remove(account.subdomain)
  deleteIdleAccount(ctx.deps.db, keyOf(account))
  ctx.missing.delete(account.githubId)
  return 'remove'
}

function keyOf(account: AccountRecord): AccountKey {
  return { githubId: account.githubId, createdAt: account.createdAt }
}

function prefixOf(ctx: SweepContext): string {
  return ctx.dryRun ? '[hub] idle sweep (dry run):' : '[hub] idle sweep:'
}

const DONE: Readonly<Record<IdleDecision, string>> = {
  keep: 'kept',
  stop: 'stopped',
  remove: 'removed with its account (no tombstone)',
}

function describe(decision: IdleDecision, dryRun: boolean): string {
  if (!dryRun || decision === 'keep') return DONE[decision]
  return `would be ${DONE[decision]}`
}

// ---------------------------------------------------------------------------
// The schedule

export interface SweepSchedule {
  readonly firstDelayMs: number
  readonly intervalMs: number
}

/** P5: the first sweep a minute after the hub starts, then every six hours. */
export const DEFAULT_SWEEP_SCHEDULE: SweepSchedule = Object.freeze({ firstDelayMs: 60 * 1000, intervalMs: 6 * 60 * 60 * 1000 })

/** What runs sweeps on a schedule: `scheduleSweeps`, or a test's hand-driven stand-in. */
export type SweepScheduler = (run: () => Promise<unknown>, schedule: SweepSchedule) => { stop(): void }

/**
 * Runs `run` after `firstDelayMs`, then `intervalMs` after each run ends — so
 * two sweeps never overlap. The timers are `unref`'d: a schedule never keeps
 * the process alive. A run that rejects does not end the schedule.
 */
export const scheduleSweeps: SweepScheduler = (run, schedule) => {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const arm = (delayMs: number): void => {
    if (stopped) return
    timer = setTimeout(() => {
      void run()
        .catch(() => undefined)
        .finally(() => arm(schedule.intervalMs))
    }, delayMs)
    timer.unref()
  }
  arm(schedule.firstDelayMs)
  return {
    stop: () => {
      stopped = true
      clearTimeout(timer)
    },
  }
}
