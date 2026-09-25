import type { AgentRecord } from '../agents/schema.js'
import type { DesiredResidents, ResidentPair } from '../pool/residents.js'
import type { StdioServerRecord } from '../registry/schema.js'
import type { SessionEndReason } from '../session/core.js'
import type { ResolveVaultRefsResult } from '../vault/resolve.js'
import type { ServeWritable } from './serve-constants.js'
import { createHeldSession, type HeldSession } from './serve-held.js'
import { acquireWith, type AcquireOps, type AcquireResult } from './serve-residents-acquire.js'
import { applyDesiredTo, type DesiredOps } from './serve-residents-desired.js'
import {
  backoffDelayMs,
  bare,
  idleWarmOf,
  isStale,
  jobOf,
  recordHashOf,
  startableAgent,
  type Entry,
} from './serve-residents-entry.js'
import { createResidentStarter, type ProcessSlot, type ResidentStarterDeps, type StartResult } from './serve-residents-start.js'

/**
 * The resident supervisor (ADR-0016): stdio servers granted to an agent run
 * before it connects and stay up between its connections. One HELD session
 * per (agent, stdio server) pair (`serve-held.ts`); this file decides every
 * transition of it — start, attach, release, restart after a pause, retire,
 * evict — and the start queue (`serve-residents-start.ts`) only their order.
 * The steps of `acquire` live in `serve-residents-acquire.ts`, those of a
 * reconcile in `serve-residents-desired.ts`; both run on this file's state.
 *
 * Budget (RS7): every live or starting process counts in `processCount`, and
 * the count drops SYNCHRONOUSLY when the supervisor decides to close. An
 * attachment adds nothing. When the budget runs short, idle warm servers
 * yield, oldest first — never a resident, never an attached one. Whatever is
 * acquired but not resident is warm: kept `idleMs` after its last release.
 */

export type { AcquireResult }

export interface ResidentSupervisorDeps {
  readonly openStart: ResidentStarterDeps['openStart']
  /** The fresh effective record of one agent (`EffectiveAgentReader.getAgent`). */
  readonly readAgent: (name: string) => Promise<AgentRecord | undefined>
  /** What a record's env resolves to now; the fingerprint checked on attach (RS4). */
  readonly resolveDeclared: (record: StdioServerRecord) => Promise<ResolveVaultRefsResult>
  readonly fingerprintOf: (record: StdioServerRecord, values: Readonly<Record<string, string>>) => string
  /** Whether the service's session budget has room for one more process. */
  readonly hasRoom: () => boolean
  readonly concurrency: number
  readonly startTimeoutMs: number
  /** How long an idle warm server lives; `<= 0` closes it at release. */
  readonly idleMs: number
  readonly maxWarmIdle: number
  readonly restartBaseMs: number
  readonly restartMaxMs: number
  readonly maxFailures: number
  readonly now: () => number
  readonly stderr: ServeWritable
}

export interface ResidentSupervisor {
  /** An attachment to this agent's own held session of `record`, started if need be. */
  acquire(pair: ResidentPair, record: StdioServerRecord, deadline: number): Promise<AcquireResult>
  /** What reconcile found: which pairs should be resident, and the stdio records. */
  applyDesired(desired: DesiredResidents, records: ReadonlyMap<string, StdioServerRecord>): void
  /** Closes the longest-idle warm server, if any; `true` when a slot was freed. */
  evictIdleWarm(): boolean
  /** Live and starting processes, as the front's ceiling counts them. */
  readonly processCount: number
  /** From now on nothing is kept: a release closes, and nothing starts. */
  seal(): void
  /** Closes everything, and waits for it. */
  closeAll(): Promise<void>
}

export function createResidentSupervisor(deps: ResidentSupervisorDeps): ResidentSupervisor {
  const entries = new Map<string, Entry>()
  const timers = new Map<string, NodeJS.Timeout>()
  const closing = new Set<Promise<void>>()
  /** Close in flight per key; a start of that key waits for it (BU4, TS review HIGH). */
  const closingByKey = new Map<string, Promise<void>>()
  /** Sessions the supervisor itself is closing: their end is not a crash. */
  const shuttingDown = new WeakSet<HeldSession>()
  let processCount = 0
  let isSealed = false

  const starter = createResidentStarter({
    concurrency: deps.concurrency,
    startTimeoutMs: deps.startTimeoutMs,
    now: deps.now,
    reserveSlot,
    openStart: deps.openStart,
  })

  function report(entry: Entry, message: string): void {
    deps.stderr.write(`[serve] ${entry.lifetime} ${entry.pair.agentName}/${entry.pair.serverName}: ${message}\n`)
  }

  /** One process slot of the shared budget; idle warm servers yield first (RS7). */
  function reserveSlot(): ProcessSlot | null {
    if (isSealed) return null
    if (!deps.hasRoom() && !(evictIdleWarm() && deps.hasRoom())) return null
    processCount += 1
    let isReleased = false
    return {
      release: () => {
        if (isReleased) return
        isReleased = true
        processCount -= 1
      },
    }
  }

  function put(entry: Entry): Entry {
    entries.set(entry.key, entry)
    return entry
  }

  function clearTimer(key: string): void {
    const timer = timers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(key)
  }

  function setTimer(key: string, ms: number, run: () => void): void {
    clearTimer(key)
    timers.set(key, setTimeout(run, Math.max(0, ms)).unref())
  }

  /** Stops an entry's process: the count drops NOW, the close is awaited by whoever asks. */
  function shutDown(entry: Entry): Promise<void> {
    clearTimer(entry.key)
    entry.slot?.release()
    const held = entry.held
    if (held === undefined) return Promise.resolve()
    shuttingDown.add(held)
    const done = held.close().finally(() => {
      closing.delete(done)
      if (closingByKey.get(entry.key) === done) closingByKey.delete(entry.key)
    })
    closing.add(done)
    closingByKey.set(entry.key, done)
    return done
  }

  /** Forgets an entry for good, closing its process — unless a newer process took the key. */
  function remove(entry: Entry, why?: string): Promise<void> {
    const current = entries.get(entry.key)
    if (current?.held === entry.held && current?.startPromise === entry.startPromise) entries.delete(entry.key)
    if (why !== undefined) report(entry, why)
    return shutDown(entry)
  }

  function start(entry: Entry, priority: boolean, after?: Promise<void>): Entry {
    clearTimer(entry.key)
    const previous = closingByKey.get(entry.key)
    report(entry, 'start queued')
    const startPromise = Promise.all([after, previous]).then(() => runStart(entry.key, priority))
    const started = put({ ...bare(entry), state: 'starting', startPromise })
    void startPromise.then((result) => onStartResult(started, result))
    return started
  }

  async function runStart(key: string, priority: boolean): Promise<StartResult> {
    const entry = entries.get(key)
    if (entry === undefined || isSealed) return { ok: false, reason: 'aborted' }
    const agent = startableAgent(await deps.readAgent(entry.pair.agentName).catch(() => undefined), entry.pair)
    if (agent === null) return { ok: false, reason: 'no-grant' }
    return starter.enqueue(jobOf(entry, agent), { priority })
  }

  function onStartResult(started: Entry, result: StartResult): void {
    const current = entries.get(started.key)
    if (current === undefined || current.startPromise !== started.startPromise || isSealed) {
      // Replaced or shut down while it was starting: nobody will ever attach.
      if (result.ok) {
        result.slot.release()
        const done = result.opened.close().finally(() => closing.delete(done))
        closing.add(done)
      }
      return
    }
    if (!result.ok) {
      onStartFailure(current, result.reason)
      return
    }
    const held = createHeldSession(
      result.opened,
      { server: current.pair.serverName, discipline: result.discipline },
      {
        onReleased: (dirty) => onReleased(current.key, held, dirty),
        onEnded: (reason) => onEnded(current.key, held, reason),
      },
    )
    const ready = put({
      ...bare(current),
      state: 'ready',
      held,
      slot: result.slot,
      fingerprint: result.fingerprint,
      knownSecrets: result.knownSecrets,
      startedHash: recordHashOf(current.record),
      failures: 0,
    })
    report(ready, `ready (${result.discipline.protocolVersion})`)
    if (ready.isRetiring) void remove(ready, 'stopped')
    else if (isStale(ready)) start(ready, false, shutDown(ready))
    else if (ready.lifetime === 'warm') goIdle(ready)
  }

  function onStartFailure(entry: Entry, reason: string): void {
    if (entry.lifetime === 'warm' || entry.isRetiring || reason === 'no-slot' || reason === 'no-grant' || reason === 'aborted') {
      // A resident with no slot waits for the next reconcile (RS7).
      void remove(entry, `did not start (${reason})`)
      return
    }
    retryLater(entry, reason)
  }

  /** A resident that failed or ended: pause, then start again — or give up (RS6). */
  function retryLater(entry: Entry, reason: string): void {
    const failures = entry.failures + 1
    if (failures >= deps.maxFailures) {
      put({ ...bare(entry), state: 'failed', failures })
      report(entry, `gave up after ${failures} failures in a row (last: ${reason})`)
      return
    }
    const delayMs = backoffDelayMs(failures, deps.restartBaseMs, deps.restartMaxMs)
    put({ ...bare(entry), state: 'backoff', failures })
    report(entry, `ended (${reason}); restarting in ${Math.ceil(delayMs / 1000)} s`)
    setTimer(entry.key, delayMs, () => {
      // By key and state, not identity: a reconcile may have replaced the entry.
      const current = entries.get(entry.key)
      if (current?.state === 'backoff' && !isSealed) start(current, false)
    })
  }

  function goIdle(entry: Entry): void {
    put({ ...entry, state: 'ready', idleSince: deps.now() })
    setTimer(entry.key, deps.idleMs, () => {
      const current = entries.get(entry.key)
      if (current?.state === 'ready' && current.lifetime === 'warm') void remove(current, 'warm server expired')
    })
    enforceWarmCap()
  }

  function enforceWarmCap(): void {
    while (idleWarmOf([...entries.values()]).length > deps.maxWarmIdle) evictIdleWarm()
  }

  function evictIdleWarm(): boolean {
    const oldest = idleWarmOf([...entries.values()])[0]
    if (oldest === undefined) return false
    void remove(oldest, 'evicted to make room')
    return true
  }

  function onReleased(key: string, held: Entry['held'], dirty: boolean): Promise<void> {
    const entry = entries.get(key)
    if (entry === undefined || entry.held !== held) return Promise.resolve()
    if (isSealed || entry.isRetiring) return remove(entry, 'stopped')
    if (dirty || isStale(entry)) {
      // RS5: calls of the pool that left may still be answered; this session
      // must never be attached again. A resident comes back fresh.
      const closed = shutDown(entry)
      if (entry.lifetime === 'resident') start(entry, false, closed)
      else entries.delete(key)
      return closed
    }
    if (entry.lifetime === 'resident') {
      put({ ...entry, state: 'ready' })
      return Promise.resolve()
    }
    if (deps.idleMs <= 0) return remove(entry)
    goIdle(entry)
    return Promise.resolve()
  }

  function onEnded(key: string, held: Entry['held'], reason: SessionEndReason | null): void {
    const entry = entries.get(key)
    // Our own close ends the session too; that end is not news.
    if (entry === undefined || held === undefined || entry.held !== held || shuttingDown.has(held)) return
    void shutDown(entry)
    if (reason === 'revoked' || entry.lifetime === 'warm' || entry.isRetiring || isSealed) {
      entries.delete(key)
      report(entry, `stopped (${reason ?? 'closed'})`)
      return
    }
    retryLater(entry, reason ?? 'closed')
  }

  const acquireOps: AcquireOps = {
    get: (key) => entries.get(key),
    put,
    start,
    shutDown,
    clearTimer,
    prioritize: (key) => starter.prioritize(key),
    isSealed: () => isSealed,
    now: deps.now,
    resolveDeclared: deps.resolveDeclared,
    fingerprintOf: deps.fingerprintOf,
  }

  function acquire(pair: ResidentPair, record: StdioServerRecord, deadline: number): Promise<AcquireResult> {
    return acquireWith(acquireOps, pair, record, deadline)
  }

  const ops: DesiredOps = {
    get: (key) => entries.get(key),
    list: () => [...entries.values()],
    put,
    start,
    shutDown,
    remove,
    clearTimer,
    goIdle,
    report,
  }

  function applyDesired(desired: DesiredResidents, records: ReadonlyMap<string, StdioServerRecord>): void {
    if (isSealed) return
    applyDesiredTo(ops, desired, records)
  }

  return {
    acquire,
    applyDesired,
    evictIdleWarm,
    get processCount(): number {
      return processCount
    },
    seal(): void {
      isSealed = true
    },
    async closeAll(): Promise<void> {
      isSealed = true
      starter.abortAll()
      const starts = [...entries.values()].flatMap((entry) => (entry.startPromise === undefined ? [] : [entry.startPromise]))
      await Promise.allSettled([...entries.values()].map((entry) => remove(entry)))
      await Promise.allSettled(starts)
      await Promise.allSettled([...closing])
    },
  }
}
