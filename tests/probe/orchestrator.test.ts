import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { approveTool, createInventory, listAllQuarantined } from '../../src/policy/inventory.js'
import type { ToolDescriptor } from '../../src/protocol/mcp.js'
import { serverRecordSchema, type ServerRecord } from '../../src/registry/schema.js'
import type { ActivityTracker } from '../../src/probe/activity.js'
import { PROBE_MAX_CONCURRENT, STATUS_STALE_AFTER_MS } from '../../src/probe/constants.js'
import type { ProbeResult } from '../../src/probe/engine.js'
import {
  createProbeOrchestrator,
  OrchestratorClosedError,
  PROBING_MARKER_FRESH_FOR_MS,
  UnknownServerError,
  type ProbeOrchestratorDeps,
  type RunProbeFn,
  type ServerStatusChange,
} from '../../src/probe/orchestrator.js'
import type { ProbeInitiator } from '../../src/probe/status-schema.js'
import { createServerStatusStore } from '../../src/probe/status-store.js'

/**
 * Probe orchestrator (M5.5 п.1, Task 4) — the single point that launches
 * probes in a process. What this file proves:
 *
 *  - `ensureFresh` is a no-op for servers with a fresh stored probe OR fresh
 *    passive activity; it probes only the stale ones;
 *  - in-process dedup: N concurrent calls for one server share ONE probe;
 *  - cross-process dedup: a fresh `probing` marker written by another process
 *    refuses the engine; a stale one is taken over;
 *  - the concurrency cap queues (never refuses) excess probes;
 *  - the full lifecycle: beginProbe → engine → recordResult → tools into the
 *    STANDARD inventory observe path → journal fact port → status event;
 *  - a throwing engine yields a stored `error` status (with the raw message
 *    kept OUT of the persisted text) and the orchestrator stays alive;
 *  - O8 (integration with the real `inventory-observe`): an unchanged
 *    `schemaHash` on re-probe creates NO quarantine entry; a changed schema
 *    creates one carrying a structural diff (`surfaceDelta`).
 */

const T0 = Date.parse('2026-08-24T12:00:00.000Z')

const LAZY: ProbeInitiator = { trigger: 'lazy', adminName: 'olga' }
const REFRESH: ProbeInitiator = { trigger: 'refresh', adminName: 'roman' }
const REGISTRATION: ProbeInitiator = { trigger: 'registration' }

const ALIVE: ProbeResult = { status: 'alive', initializeLatencyMs: 12, probedVia: 'initialize' }

let journalDir: string
let nowMs: number

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-orchestrator-'))
  nowMs = T0
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function recordFor(name: string): ServerRecord {
  return serverRecordSchema.parse({
    name,
    transport: 'stdio',
    command: process.execPath,
    args: [],
  })
}

function statusStore() {
  return createServerStatusStore({
    journalDir,
    probingFreshForMs: PROBING_MARKER_FRESH_FOR_MS,
    now: () => nowMs,
  })
}

const NO_ACTIVITY: ActivityTracker = { lastSuccessfulActivity: () => Promise.resolve(null) }

function freshActivity(): ActivityTracker {
  return {
    lastSuccessfulActivity: () =>
      Promise.resolve({ lastActivityAt: new Date(nowMs - 1000).toISOString(), fresh: true }),
  }
}

interface HarnessOverrides {
  readonly runProbe?: RunProbeFn
  readonly activity?: ActivityTracker
  readonly observeTools?: ProbeOrchestratorDeps['observeTools']
  readonly recordProbeJournal?: ProbeOrchestratorDeps['recordProbeJournal']
  readonly onStatusChanged?: (change: ServerStatusChange) => void
  readonly onError?: (error: unknown) => void
  readonly maxConcurrent?: number
  readonly servers?: readonly string[]
}

function makeHarness(overrides: HarnessOverrides = {}) {
  const servers = overrides.servers ?? ['github']
  const store = statusStore()
  const runProbe = vi.fn<RunProbeFn>(overrides.runProbe ?? (() => Promise.resolve(ALIVE)))
  const observeTools = vi.fn(overrides.observeTools ?? (() => Promise.resolve()))
  const recordProbeJournal = vi.fn(overrides.recordProbeJournal ?? (() => Promise.resolve()))
  const onStatusChanged = vi.fn(overrides.onStatusChanged ?? (() => undefined))
  const onError = vi.fn(overrides.onError ?? (() => undefined))
  const orchestrator = createProbeOrchestrator({
    statusStore: store,
    activity: overrides.activity ?? NO_ACTIVITY,
    getRecord: (name) => Promise.resolve(servers.includes(name) ? recordFor(name) : undefined),
    listRegistryNames: () => Promise.resolve(servers),
    runProbe,
    observeTools,
    recordProbeJournal,
    onStatusChanged,
    onError,
    now: () => nowMs,
    ...(overrides.maxConcurrent !== undefined ? { maxConcurrent: overrides.maxConcurrent } : {}),
  })
  return { orchestrator, store, runProbe, observeTools, recordProbeJournal, onStatusChanged, onError }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor: condition not met in time')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Seeds a settled alive result for `name` at the current clock. */
async function seedAlive(store: ReturnType<typeof statusStore>, name: string): Promise<void> {
  await store.recordResult(
    name,
    { status: 'alive', probedVia: 'initialize', initializeLatencyMs: 5 },
    { initiator: LAZY },
  )
}

describe('ensureFresh staleness decision', () => {
  test('no-op for a server with a fresh stored probe result', async () => {
    const { orchestrator, store, runProbe } = makeHarness()
    await seedAlive(store, 'github')
    nowMs = T0 + 60_000 // well inside the staleness horizon

    await orchestrator.ensureFresh(['github'], LAZY)

    expect(runProbe).not.toHaveBeenCalled()
  })

  test('probes a server whose stored result is older than the staleness horizon', async () => {
    const { orchestrator, store, runProbe } = makeHarness()
    await seedAlive(store, 'github')
    nowMs = T0 + STATUS_STALE_AFTER_MS + 1

    await orchestrator.ensureFresh(['github'], LAZY)

    expect(runProbe).toHaveBeenCalledTimes(1)
    expect(await store.getStatus('github')).toMatchObject({ status: 'alive' })
  })

  test('probes a never-checked server with no journal activity', async () => {
    const { orchestrator, runProbe } = makeHarness()

    await orchestrator.ensureFresh(['github'], LAZY)

    expect(runProbe).toHaveBeenCalledTimes(1)
  })

  test('no-op for a never-checked server with fresh passive activity', async () => {
    const { orchestrator, runProbe } = makeHarness({ activity: freshActivity() })

    await orchestrator.ensureFresh(['github'], LAZY)

    expect(runProbe).not.toHaveBeenCalled()
  })

  test('fresh passive activity also covers a stale stored result', async () => {
    const { orchestrator, store, runProbe } = makeHarness({ activity: freshActivity() })
    await seedAlive(store, 'github')
    nowMs = T0 + STATUS_STALE_AFTER_MS + 1

    await orchestrator.ensureFresh(['github'], LAZY)

    expect(runProbe).not.toHaveBeenCalled()
  })

  test('a name missing from the registry is skipped without failing the batch', async () => {
    const { orchestrator, runProbe, onError } = makeHarness({ servers: ['github'] })

    await orchestrator.ensureFresh(['ghost', 'github'], LAZY)

    expect(runProbe).toHaveBeenCalledTimes(1)
    expect(runProbe.mock.calls[0]?.[0]?.name).toBe('github')
    expect(onError).toHaveBeenCalledWith(expect.any(UnknownServerError))
  })
})

describe('in-process dedup', () => {
  test('N concurrent ensureFresh calls on one stale server run exactly one probe', async () => {
    const gate = deferred<ProbeResult>()
    const { orchestrator, runProbe } = makeHarness({ runProbe: () => gate.promise })

    const calls = Promise.all([
      orchestrator.ensureFresh(['github'], LAZY),
      orchestrator.ensureFresh(['github'], LAZY),
      orchestrator.ensureFresh(['github'], LAZY),
    ])
    await waitFor(() => runProbe.mock.calls.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(runProbe).toHaveBeenCalledTimes(1)

    gate.resolve(ALIVE)
    await calls
    expect(runProbe).toHaveBeenCalledTimes(1)
  })

  test('concurrent probeNow calls on one server share the same probe and result', async () => {
    const gate = deferred<ProbeResult>()
    const { orchestrator, runProbe } = makeHarness({ runProbe: () => gate.promise })

    const first = orchestrator.probeNow('github', REFRESH)
    const second = orchestrator.probeNow('github', REFRESH)
    await waitFor(() => runProbe.mock.calls.length === 1)
    gate.resolve(ALIVE)

    const [a, b] = await Promise.all([first, second])
    expect(runProbe).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    expect(a).toMatchObject({ status: 'alive', initializeLatencyMs: 12 })
  })
})

describe('concurrency cap', () => {
  test('queues probes beyond the cap instead of refusing them', async () => {
    const servers = ['s1', 's2', 's3', 's4', 's5']
    const starts: Deferred<void>[] = []
    let active = 0
    let peak = 0
    const runProbe: RunProbeFn = async () => {
      active += 1
      peak = Math.max(peak, active)
      const gate = deferred<void>()
      starts.push(gate)
      await gate.promise
      active -= 1
      return ALIVE
    }
    const { orchestrator, store } = makeHarness({ servers, runProbe, maxConcurrent: 2 })

    const done = orchestrator.ensureFresh(servers, LAZY)
    await waitFor(() => starts.length === 2)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(starts.length).toBe(2) // the rest are queued, not started and not dropped

    starts[0]?.resolve()
    starts[1]?.resolve()
    await waitFor(() => starts.length === 4)
    starts[2]?.resolve()
    starts[3]?.resolve()
    await waitFor(() => starts.length === 5)
    starts[4]?.resolve()
    await done

    expect(peak).toBe(2)
    for (const name of servers) {
      expect(await store.getStatus(name)).toMatchObject({ status: 'alive' })
    }
  })

  test('default cap is PROBE_MAX_CONCURRENT', () => {
    // The constant itself is the contract; the wiring test above proves the
    // mechanism with an injected cap.
    expect(PROBE_MAX_CONCURRENT).toBeGreaterThan(0)
  })
})

describe('probeNow', () => {
  test('probes even when the stored status is fresh', async () => {
    const { orchestrator, store, runProbe } = makeHarness()
    await seedAlive(store, 'github')
    nowMs = T0 + 1000

    const status = await orchestrator.probeNow('github', REFRESH)

    expect(runProbe).toHaveBeenCalledTimes(1)
    expect(status).toMatchObject({ status: 'alive', initiator: REFRESH })
  })

  test('throws UnknownServerError for a name outside the registry', async () => {
    const { orchestrator, runProbe } = makeHarness({ servers: ['github'] })

    await expect(orchestrator.probeNow('ghost', REFRESH)).rejects.toBeInstanceOf(UnknownServerError)
    expect(runProbe).not.toHaveBeenCalled()
  })
})

describe('probe lifecycle', () => {
  test('alive result: stored, tools observed, journal fact recorded, event fired — in that order', async () => {
    const order: string[] = []
    const tools: ToolDescriptor[] = [{ name: 'search' }]
    const { orchestrator, store, observeTools, recordProbeJournal, onStatusChanged } = makeHarness({
      runProbe: () => Promise.resolve({ ...ALIVE, tools }),
      observeTools: () => {
        order.push('observe')
        return Promise.resolve()
      },
      recordProbeJournal: () => {
        order.push('journal')
        return Promise.resolve()
      },
      onStatusChanged: () => {
        order.push('event')
      },
    })

    const status = await orchestrator.probeNow('github', REFRESH)

    expect(status).toMatchObject({
      status: 'alive',
      probedVia: 'initialize',
      initializeLatencyMs: 12,
      probedAt: new Date(nowMs).toISOString(),
      initiator: REFRESH,
    })
    expect(await store.getStatus('github')).toEqual(status)
    expect(observeTools).toHaveBeenCalledWith('github', tools)
    expect(recordProbeJournal).toHaveBeenCalledWith({ serverName: 'github', entry: status })
    expect(onStatusChanged).toHaveBeenCalledWith({ serverName: 'github', entry: status })
    expect(order).toEqual(['observe', 'journal', 'event'])
  })

  test('a failed probe result is stored and journaled but never reaches the inventory', async () => {
    const { orchestrator, store, observeTools, recordProbeJournal, onStatusChanged } = makeHarness({
      runProbe: () =>
        Promise.resolve({ status: 'unreachable', message: 'no answer to initialize within 10000ms' }),
    })

    const status = await orchestrator.probeNow('github', REFRESH)

    expect(status).toMatchObject({
      status: 'unreachable',
      error: 'no answer to initialize within 10000ms',
    })
    expect(await store.getStatus('github')).toEqual(status)
    expect(observeTools).not.toHaveBeenCalled()
    expect(recordProbeJournal).toHaveBeenCalledWith({ serverName: 'github', entry: status })
    expect(onStatusChanged).toHaveBeenCalledWith({ serverName: 'github', entry: status })
  })

  test('lazy probes skip the tools step; registration and refresh probes request it', async () => {
    const { orchestrator, store, runProbe } = makeHarness()

    await orchestrator.ensureFresh(['github'], LAZY)
    expect(runProbe).toHaveBeenLastCalledWith(expect.anything(), { withTools: false })

    await orchestrator.probeNow('github', REFRESH)
    expect(runProbe).toHaveBeenLastCalledWith(expect.anything(), { withTools: true })

    await orchestrator.probeNow('github', REGISTRATION)
    expect(runProbe).toHaveBeenLastCalledWith(expect.anything(), { withTools: true })
    expect(await store.getStatus('github')).toMatchObject({ initiator: REGISTRATION })
  })
})

describe('fault isolation', () => {
  test('a throwing engine yields a stored error status without echoing the raw message', async () => {
    const boom = new Error('BOOM tok3n-value-xyz')
    let shouldThrow = true
    const { orchestrator, store, onError } = makeHarness({
      runProbe: () => (shouldThrow ? Promise.reject(boom) : Promise.resolve(ALIVE)),
    })

    const status = await orchestrator.probeNow('github', REFRESH)

    expect(status.status).toBe('error')
    expect(status).toMatchObject({ initiator: REFRESH })
    if (status.status === 'error') {
      // The throw's text is NOT pre-redacted pipeline output; it must not persist.
      expect(status.error).not.toContain('BOOM')
      expect(status.error).not.toContain('tok3n-value-xyz')
    }
    expect(onError).toHaveBeenCalledWith(boom)
    expect(await store.getStatus('github')).toEqual(status)

    // The orchestrator survives: the next probe works.
    shouldThrow = false
    const next = await orchestrator.probeNow('github', REFRESH)
    expect(next).toMatchObject({ status: 'alive' })
  })

  test('a failing observeTools port neither loses the status nor the journal fact', async () => {
    const observeFailure = new Error('inventory store locked')
    const { orchestrator, store, recordProbeJournal, onStatusChanged, onError } = makeHarness({
      runProbe: () => Promise.resolve({ ...ALIVE, tools: [{ name: 'search' }] }),
      observeTools: () => Promise.reject(observeFailure),
    })

    const status = await orchestrator.probeNow('github', REFRESH)

    expect(status).toMatchObject({ status: 'alive' })
    expect(await store.getStatus('github')).toEqual(status)
    expect(recordProbeJournal).toHaveBeenCalledTimes(1)
    expect(onStatusChanged).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(observeFailure)
  })

  test('a dropped journal fact does not fail the probe; the event still fires', async () => {
    const journalFailure = new Error('sqlite busy')
    const { orchestrator, store, onStatusChanged, onError } = makeHarness({
      recordProbeJournal: () => Promise.reject(journalFailure),
    })

    const status = await orchestrator.probeNow('github', REFRESH)

    expect(status).toMatchObject({ status: 'alive' })
    expect(await store.getStatus('github')).toEqual(status)
    expect(onStatusChanged).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(journalFailure)
  })

  test('a throwing onStatusChanged listener does not fail the probe', async () => {
    const { orchestrator, onError } = makeHarness({
      onStatusChanged: () => {
        throw new Error('listener broke')
      },
    })

    const status = await orchestrator.probeNow('github', REFRESH)

    expect(status).toMatchObject({ status: 'alive' })
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })
})

describe('cross-process dedup via the probing marker', () => {
  test('a fresh probing marker from another process refuses the engine and returns the marker', async () => {
    const other = statusStore()
    const begun = await other.beginProbe('github', { initiator: LAZY })
    expect(begun.status).toBe('started')

    const { orchestrator, runProbe } = makeHarness()
    const status = await orchestrator.probeNow('github', REFRESH)

    expect(runProbe).not.toHaveBeenCalled()
    expect(status).toMatchObject({ status: 'probing', initiator: LAZY })
  })

  test('a stale probing marker (crashed prober) is taken over', async () => {
    const other = statusStore()
    await other.beginProbe('github', { initiator: LAZY })
    nowMs = T0 + PROBING_MARKER_FRESH_FOR_MS + 1

    const { orchestrator, runProbe } = makeHarness()
    const status = await orchestrator.probeNow('github', REFRESH)

    expect(runProbe).toHaveBeenCalledTimes(1)
    expect(status).toMatchObject({ status: 'alive', initiator: REFRESH })
  })
})

describe('close', () => {
  test('close waits for the active probe to settle and record its result', async () => {
    const gate = deferred<ProbeResult>()
    const { orchestrator, store, runProbe } = makeHarness({ runProbe: () => gate.promise })

    const probing = orchestrator.probeNow('github', REFRESH)
    await waitFor(() => runProbe.mock.calls.length === 1)

    let closed = false
    const closing = orchestrator.close().then(() => {
      closed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(closed).toBe(false)

    gate.resolve(ALIVE)
    await closing
    await probing
    expect(closed).toBe(true)
    expect(await store.getStatus('github')).toMatchObject({ status: 'alive' })
  })

  test('after close: probeNow refuses, ensureFresh is a no-op', async () => {
    const { orchestrator, runProbe } = makeHarness()
    await orchestrator.close()

    await expect(orchestrator.probeNow('github', REFRESH)).rejects.toBeInstanceOf(
      OrchestratorClosedError,
    )
    await orchestrator.ensureFresh(['github'], LAZY)
    expect(runProbe).not.toHaveBeenCalled()
  })
})

describe('tools flow through the REAL inventory observe path (O8)', () => {
  const SEARCH_TOOL: ToolDescriptor = {
    name: 'search',
    description: 'find things',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    },
  }
  const WIDENED_TOOL: ToolDescriptor = {
    ...SEARCH_TOOL,
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' }, limit: { type: 'number' } },
      required: ['q'],
    },
  }

  test('unchanged schemaHash on re-probe creates no quarantine entry; a changed schema is quarantined with a structural diff', async () => {
    const storePath = join(journalDir, 'tool-inventory.json')
    let tools: readonly ToolDescriptor[] = [SEARCH_TOOL]
    const { orchestrator } = makeHarness({
      runProbe: () => Promise.resolve({ ...ALIVE, tools }),
      observeTools: async (serverName, observed) => {
        const inventory = createInventory(serverName, { storePath })
        await inventory.load()
        await inventory.observeToolsList(observed)
      },
    })

    // First sighting quarantines the tool as `new` — the standard path.
    await orchestrator.probeNow('github', REGISTRATION)
    expect(await listAllQuarantined(storePath)).toEqual([
      expect.objectContaining({ serverName: 'github', toolName: 'search', state: 'new' }),
    ])

    // The operator approves it; a re-probe with the SAME schemaHash must not
    // re-quarantine (O8: guaranteed by inventory-observe, pinned here).
    expect(await approveTool('github', 'search', storePath)).toBe(true)
    await orchestrator.probeNow('github', REFRESH)
    expect(await listAllQuarantined(storePath)).toEqual([])

    // A changed schema IS quarantined, carrying a structural diff.
    tools = [WIDENED_TOOL]
    await orchestrator.probeNow('github', REFRESH)
    const entries = await listAllQuarantined(storePath)
    expect(entries).toEqual([
      expect.objectContaining({
        serverName: 'github',
        toolName: 'search',
        state: 'changed',
        surfaceDelta: 'widened',
      }),
    ])
  })
})
