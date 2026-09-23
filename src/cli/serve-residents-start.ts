import type { AgentRecord } from '../agents/schema.js'
import type { PoolMemberDiscipline } from '../pool/handshake.js'
import type { ResidentPair } from '../pool/residents.js'
import type { StdioServerRecord } from '../registry/schema.js'
import type { OpenedChildSession } from './serve-child.js'

/**
 * The start queue of the resident supervisor (ADR-0016, BU4): every start of
 * a held stdio server — resident or warm — goes through here.
 *
 *  - At most `concurrency` starts run at once, across the service (owner
 *    decision D1+, "no more than 2").
 *  - Two jobs with the same command line (`command` + `args`) NEVER run in
 *    parallel: concurrent `npx -y` of one package in a cold cache break
 *    `~/.npm/_npx` (phase-5 smoke, Ф2). The later one waits its turn.
 *  - A start an agent is waiting on jumps the queue (`priority`,
 *    `prioritize`): after a restart of `serve` the agent must not wait for
 *    everybody else's servers.
 *
 * The slot is claimed right before the open, and handed back only if the
 * start fails: on success it becomes the supervisor's count of that process,
 * so nothing is counted twice (RS7).
 *
 * The open itself is injected (`serve-residents-open.ts`), which keeps this
 * file about ORDER, and testable without a single process.
 */

export interface StartJob {
  readonly key: string
  readonly pair: ResidentPair
  /** `JSON.stringify([command, ...args])`: equal strings never start together. */
  readonly commandKey: string
  /** The fresh effective agent record: the held session's watch starts from it. */
  readonly agent: AgentRecord
  readonly record: StdioServerRecord
}

/** A claim on one process slot of the service's budget. */
export interface ProcessSlot {
  /** Gives it back. Idempotent. */
  release(): void
}

/** What a successful open hands back, before the queue adds the slot. */
export interface OpenedStart {
  readonly ok: true
  readonly opened: OpenedChildSession
  readonly discipline: PoolMemberDiscipline
  /** sha256 of the record and the values its env resolved to; never the values. */
  readonly fingerprint: string
  /** Exact values the process was given, for the pool journal's redaction. */
  readonly knownSecrets: readonly string[]
}

export type OpenStartResult = OpenedStart | { readonly ok: false; readonly reason: string }

export type StartResult =
  | (OpenedStart & { readonly slot: ProcessSlot })
  | { readonly ok: false; readonly reason: string }

export interface ResidentStarterDeps {
  readonly concurrency: number
  readonly startTimeoutMs: number
  readonly now: () => number
  /** Claims one process slot, or `null` when the service has none (`no-slot`). */
  readonly reserveSlot: () => ProcessSlot | null
  /** Opens and negotiates one held session by `deadline`; aborts on `signal`. */
  readonly openStart: (job: StartJob, deadline: number, signal: AbortSignal) => Promise<OpenStartResult>
}

export interface ResidentStarter {
  /** Queues a start; the same key queued twice shares one start. */
  enqueue(job: StartJob, options?: { readonly priority?: boolean }): Promise<StartResult>
  /** Moves a queued start to the front (an agent is waiting on it). */
  prioritize(key: string): void
  /** Ends everything: running starts are aborted, queued ones refused. */
  abortAll(): void
  readonly running: number
  readonly queued: number
}

/** The reason a start the queue never ran carries. */
export const START_ABORTED_REASON = 'aborted'

/** The reason a start that found no process slot carries. */
export const START_NO_SLOT_REASON = 'no-slot'

interface Queued {
  readonly job: StartJob
  readonly promise: Promise<StartResult>
  readonly settle: (result: StartResult) => void
}

export function createResidentStarter(deps: ResidentStarterDeps): ResidentStarter {
  /** Replaced whole on every change, never mutated in place. */
  let queue: readonly Queued[] = []
  const running = new Map<string, { readonly entry: Queued; readonly abort: AbortController }>()
  let isAborted = false

  function commandsRunning(): ReadonlySet<string> {
    return new Set([...running.values()].map(({ entry }) => entry.job.commandKey))
  }

  function pump(): void {
    while (running.size < deps.concurrency) {
      const busy = commandsRunning()
      const next = queue.find((entry) => !busy.has(entry.job.commandKey))
      if (next === undefined) return
      queue = queue.filter((entry) => entry !== next)
      run(next)
    }
  }

  function run(entry: Queued): void {
    const slot = deps.reserveSlot()
    if (slot === null) {
      entry.settle({ ok: false, reason: START_NO_SLOT_REASON })
      return
    }
    const abort = new AbortController()
    running.set(entry.job.key, { entry, abort })
    const deadline = deps.now() + deps.startTimeoutMs
    void deps
      .openStart(entry.job, deadline, abort.signal)
      .catch((error: unknown): OpenStartResult => ({ ok: false, reason: describe(error) }))
      .then((result) => {
        running.delete(entry.job.key)
        if (!result.ok) slot.release()
        entry.settle(result.ok ? { ...result, slot } : result)
        pump()
      })
  }

  function findQueued(key: string): Queued | undefined {
    return queue.find((entry) => entry.job.key === key) ?? running.get(key)?.entry
  }

  return {
    enqueue(job: StartJob, options?: { readonly priority?: boolean }): Promise<StartResult> {
      if (isAborted) return Promise.resolve({ ok: false, reason: START_ABORTED_REASON })
      const existing = findQueued(job.key)
      if (existing !== undefined) {
        if (options?.priority === true) this.prioritize(job.key)
        return existing.promise
      }
      let settle!: (result: StartResult) => void
      const promise = new Promise<StartResult>((resolve) => {
        settle = resolve
      })
      const entry: Queued = { job, promise, settle }
      queue = options?.priority === true ? [entry, ...queue] : [...queue, entry]
      pump()
      return promise
    },

    prioritize(key: string): void {
      const entry = queue.find((candidate) => candidate.job.key === key)
      if (entry === undefined) return
      queue = [entry, ...queue.filter((candidate) => candidate !== entry)]
    },

    abortAll(): void {
      isAborted = true
      const waiting = queue
      queue = []
      for (const entry of waiting) entry.settle({ ok: false, reason: START_ABORTED_REASON })
      for (const { abort } of running.values()) abort.abort()
    },

    get running(): number {
      return running.size
    },
    get queued(): number {
      return queue.length
    },
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
