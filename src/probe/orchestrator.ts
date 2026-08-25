import type { ToolDescriptor } from '../protocol/mcp.js'
import type { ServerRecord } from '../registry/schema.js'
import type { ActivityTracker } from './activity.js'
import { PROBE_MAX_CONCURRENT, PROBE_TIMEOUT_MS, STATUS_STALE_AFTER_MS } from './constants.js'
import type { ProbeResult } from './engine.js'
import type {
  ProbeInitiator,
  ProbingServerStatus,
  ServerStatus,
  StoredServerStatus,
} from './status-schema.js'
import type { ProbeResultInput, ServerStatusStore, StatusWriteContext } from './status-store.js'

/**
 * The probe orchestrator (M5.5 п.1, Task 4; threat model: ADR-0008) — the
 * ONLY point that launches probes in a process. It owns the three fan-out
 * limiters the ADR demands:
 *
 *  - staleness: `ensureFresh` probes a server only when it has neither a
 *    fresh stored probe result nor fresh passive activity from the journal
 *    (both horizons = `STATUS_STALE_AFTER_MS`);
 *  - in-process dedup: concurrent callers for one server AWAIT the same
 *    probe (one engine run, one result);
 *  - cross-process dedup: `beginProbe`'s `probing` marker — a fresh marker
 *    written by another process refuses the engine here and the marker
 *    itself is returned as the current status; a stale marker (crashed
 *    prober) is taken over by the store;
 *  - a concurrency cap that QUEUES excess probes (never refuses them).
 *
 * Deliberately absent: any timer, interval, or watcher (O2). Every probe is
 * caused by a call on this object; `close()` only waits, it schedules
 * nothing. The engine, the inventory observe path, and the journal fact are
 * PORTS (`runProbe`, `observeTools`, `recordProbeJournal`) — composition
 * happens in `cli/ui-wiring.ts`, where the vault may be touched
 * (`src/probe/**` itself never imports `src/ui/**` or `src/cli/**`).
 */

/** Slack added to the worst-case probe duration before a `probing` marker counts as dead. */
export const PROBING_MARKER_SLACK_MS = 1_000

/**
 * Freshness window for the cross-process `probing` marker: a probe takes at
 * most two timed steps (probe message + `tools/list`, `PROBE_TIMEOUT_MS`
 * each), so a marker older than 2× the timeout plus slack can only belong
 * to a crashed prober. Pass this as `probingFreshForMs` when creating the
 * `ServerStatusStore` the orchestrator is composed with.
 */
export const PROBING_MARKER_FRESH_FOR_MS = 2 * PROBE_TIMEOUT_MS + PROBING_MARKER_SLACK_MS

/** A stored status that is not the in-flight marker: every settled probe outcome. */
export type SettledServerStatus = Exclude<StoredServerStatus, ProbingServerStatus>

/** One settled probe, as handed to the journal port and the status event. */
export interface ServerStatusChange {
  readonly serverName: string
  readonly entry: SettledServerStatus
}

/** The engine port; bound to `probe(record, …)` with vault deps by the wiring. */
export type RunProbeFn = (
  record: ServerRecord,
  opts: { readonly withTools: boolean },
) => Promise<ProbeResult>

/** The standard inventory observe path (O8); bound to `Inventory.observeToolsList`. */
export type ObserveToolsFn = (
  serverName: string,
  tools: readonly ToolDescriptor[],
) => Promise<void>

/** The journal fact port (`kind: 'probe'` record — Task 5 implements it). */
export type RecordProbeJournalFn = (change: ServerStatusChange) => Promise<void>

/** Raised by `probeNow` for a name that is not in the registry. */
export class UnknownServerError extends Error {
  constructor(name: string) {
    super(`unknown server: ${JSON.stringify(name)}`)
    this.name = 'UnknownServerError'
  }
}

/** Raised by `probeNow` after `close()`. */
export class OrchestratorClosedError extends Error {
  constructor() {
    super('the probe orchestrator is closed')
    this.name = 'OrchestratorClosedError'
  }
}

export interface ProbeOrchestratorDeps {
  readonly statusStore: ServerStatusStore
  readonly activity: ActivityTracker
  /** Registry lookup; `undefined` = the server is not registered. */
  readonly getRecord: (serverName: string) => Promise<ServerRecord | undefined>
  /** Current registry names for the store's lazy cleanup of removed servers. */
  readonly listRegistryNames?: () => Promise<readonly string[]>
  readonly runProbe: RunProbeFn
  readonly observeTools: ObserveToolsFn
  readonly recordProbeJournal: RecordProbeJournalFn
  /** Fired after every settled probe (UI wires SSE here; CLI wires nothing). */
  readonly onStatusChanged?: (change: ServerStatusChange) => void
  /** Diagnostic sink for non-fatal faults (ports failing, unknown names in a batch). */
  readonly onError?: (error: unknown) => void
  /** Clock in epoch ms; injectable for deterministic staleness tests. */
  readonly now?: () => number
  /** Staleness horizon; defaults to `STATUS_STALE_AFTER_MS`. */
  readonly staleAfterMs?: number
  /** Concurrency cap; defaults to `PROBE_MAX_CONCURRENT`. */
  readonly maxConcurrent?: number
}

export interface ProbeOrchestrator {
  /**
   * Lazy trigger (O2): probes only the listed servers that are STALE — no
   * fresh stored result and no fresh passive activity. Resolves when every
   * probe it started has settled; per-server faults go to `onError`, never
   * to the caller (a page render must not fail because one probe did).
   */
  ensureFresh(serverNames: readonly string[], initiator: ProbeInitiator): Promise<void>
  /**
   * Forced trigger (registration, refresh): probes regardless of freshness.
   * Joins an already in-flight in-process probe for the same server; a fresh
   * cross-process `probing` marker is returned as the current status.
   */
  probeNow(serverName: string, initiator: ProbeInitiator): Promise<ServerStatus>
  /** Waits for every active probe to settle. Starts nothing new. */
  close(): Promise<void>
}

export function createProbeOrchestrator(deps: ProbeOrchestratorDeps): ProbeOrchestrator {
  const now = deps.now ?? Date.now
  const staleAfterMs = deps.staleAfterMs ?? STATUS_STALE_AFTER_MS
  const onError = deps.onError ?? defaultOnError
  const slots = createSemaphore(deps.maxConcurrent ?? PROBE_MAX_CONCURRENT)
  const inflight = new Map<string, Promise<ServerStatus>>()
  let closed = false

  /** In-process dedup: one shared probe promise per server name. */
  function shared(serverName: string, initiator: ProbeInitiator): Promise<ServerStatus> {
    const existing = inflight.get(serverName)
    if (existing !== undefined) {
      return existing
    }
    const task = runOne(serverName, initiator).finally(() => inflight.delete(serverName))
    inflight.set(serverName, task)
    return task
  }

  /** One probe under a concurrency slot (queued, never refused). */
  async function runOne(serverName: string, initiator: ProbeInitiator): Promise<ServerStatus> {
    await slots.acquire()
    try {
      return await probeUnderSlot(serverName, initiator)
    } finally {
      slots.release()
    }
  }

  /** The full lifecycle: beginProbe → engine → recordResult → observe → journal → event. */
  async function probeUnderSlot(
    serverName: string,
    initiator: ProbeInitiator,
  ): Promise<ServerStatus> {
    const record = await deps.getRecord(serverName)
    if (record === undefined) {
      throw new UnknownServerError(serverName)
    }
    const ctx = await writeContext(initiator)
    const begun = await deps.statusStore.beginProbe(serverName, ctx)
    if (begun.status === 'already-probing') {
      return begun.entry
    }
    const result = await runEngine(record, initiator)
    const stored = await deps.statusStore.recordResult(serverName, toResultInput(result), ctx)
    await settle(serverName, result, settledOf(stored))
    return stored
  }

  /** The engine never throws by contract; a throw is still caught — the orchestrator stays alive. */
  async function runEngine(record: ServerRecord, initiator: ProbeInitiator): Promise<ProbeResult> {
    try {
      // Lazy probes answer "is it alive"; registration/refresh also re-shoot
      // the tool surface (O8).
      return await deps.runProbe(record, { withTools: initiator.trigger !== 'lazy' })
    } catch (error: unknown) {
      // The raw message did not pass the engine's redaction discipline, so it
      // must not persist; the full cause goes to the process-local sink only.
      onError(error)
      return { status: 'error', message: `the probe failed unexpectedly (${nameOf(error)})` }
    }
  }

  /** Post-record steps; every port fault is contained (status-first — plan Task 5). */
  async function settle(
    serverName: string,
    result: ProbeResult,
    entry: SettledServerStatus,
  ): Promise<void> {
    const tools = result.status === 'alive' ? result.tools : undefined
    if (tools !== undefined) {
      await guarded(() => deps.observeTools(serverName, tools))
    }
    await guarded(() => deps.recordProbeJournal({ serverName, entry }))
    await guarded(() => Promise.resolve(deps.onStatusChanged?.({ serverName, entry })))
  }

  async function guarded(step: () => Promise<unknown>): Promise<void> {
    try {
      await step()
    } catch (error: unknown) {
      onError(error)
    }
  }

  /** Registry names ride along for the store's lazy cleanup; failure to list them never blocks a probe. */
  async function writeContext(initiator: ProbeInitiator): Promise<StatusWriteContext> {
    if (deps.listRegistryNames === undefined) {
      return { initiator }
    }
    try {
      return { initiator, registryNames: await deps.listRegistryNames() }
    } catch (error: unknown) {
      onError(error)
      return { initiator }
    }
  }

  /** Stale = no fresh stored result AND no fresh passive activity (O1 hybrid). */
  async function isStale(serverName: string): Promise<boolean> {
    const status = await deps.statusStore.getStatus(serverName)
    if (isFreshStatus(status)) {
      return false
    }
    const activity = await deps.activity.lastSuccessfulActivity(serverName)
    return activity?.fresh !== true
  }

  function isFreshStatus(status: ServerStatus): boolean {
    if (status.status === 'never-checked') {
      return false
    }
    if (status.status === 'probing') {
      // Not settled: attempt a probe and let `beginProbe` arbitrate — a fresh
      // marker refuses the engine, a stale one is taken over.
      return false
    }
    return now() - Date.parse(status.probedAt) < staleAfterMs
  }

  async function ensureFresh(
    serverNames: readonly string[],
    initiator: ProbeInitiator,
  ): Promise<void> {
    if (closed) {
      return
    }
    const stale: string[] = []
    for (const serverName of new Set(serverNames)) {
      if (await isStale(serverName)) {
        stale.push(serverName)
      }
    }
    // One server's failure (e.g. removed from the registry mid-render) never
    // fails the batch: the trigger is a page view, not a transaction.
    await Promise.all(stale.map((serverName) => shared(serverName, initiator).catch(onError)))
  }

  function probeNow(serverName: string, initiator: ProbeInitiator): Promise<ServerStatus> {
    if (closed) {
      return Promise.reject(new OrchestratorClosedError())
    }
    return shared(serverName, initiator)
  }

  async function close(): Promise<void> {
    closed = true
    await Promise.allSettled([...inflight.values()])
  }

  return { ensureFresh, probeNow, close }
}

/** Narrows a just-recorded entry: `recordResult` can only have written a settled one. */
function settledOf(entry: StoredServerStatus): SettledServerStatus {
  if (entry.status === 'probing') {
    throw new Error('recordResult returned a probing entry (bug)')
  }
  return entry
}

function toResultInput(result: ProbeResult): ProbeResultInput {
  if (result.status === 'alive') {
    return {
      status: 'alive',
      probedVia: result.probedVia,
      initializeLatencyMs: result.initializeLatencyMs,
    }
  }
  return { status: result.status, error: result.message }
}

/** The error's CLASS name only — a structural summary, never the message. */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

function defaultOnError(error: unknown): void {
  process.stderr.write(
    `[probe-orchestrator] ${error instanceof Error ? error.message : String(error)}\n`,
  )
}

interface Semaphore {
  acquire(): Promise<void>
  release(): void
}

/**
 * Minimal FIFO semaphore. `release` hands its slot DIRECTLY to the oldest
 * waiter (no decrement-then-increment window): a fresh `acquire` racing the
 * hand-off always sees the slot as taken and queues, so the cap can never be
 * exceeded by a microtask interleaving. No timers involved (O2).
 */
function createSemaphore(limit: number): Semaphore {
  let active = 0
  const waiters: Array<() => void> = []

  async function acquire(): Promise<void> {
    if (active < limit) {
      active += 1
      return
    }
    // The resolved waiter INHERITS the releaser's slot; `active` is untouched.
    await new Promise<void>((resolve) => waiters.push(resolve))
  }

  function release(): void {
    const next = waiters.shift()
    if (next !== undefined) {
      next()
      return
    }
    active -= 1
  }

  return { acquire, release }
}
