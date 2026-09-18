import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ProbeInitiator } from '../../src/probe/status-schema.js'
import {
  createServerStatusStore,
  InvalidStatusServerNameError,
  InvalidStatusWriteError,
} from '../../src/probe/status-store.js'
import { createRegistryStore } from '../../src/registry/store.js'

/**
 * `server-status.json` document store (M5.5 p.1, Task 2). The `probing` state
 * doubles as the cross-process probe dedup marker, so its freshness semantics
 * (fresh refuses a second writer, stale is taken over) are the core contract
 * under test. Timestamps come from an injected clock — racing real wall time
 * would make the takeover tests flaky by construction.
 */

/** Stands in for `PROBE_TIMEOUT_MS + ε` from the orchestrator (Task 1/4 owns the constant). */
const PROBING_FRESH_FOR_MS = 10_000
const T0 = Date.parse('2026-08-24T10:00:00.000Z')

const LAZY: ProbeInitiator = { trigger: 'lazy', adminName: 'olga' }
const REFRESH: ProbeInitiator = { trigger: 'refresh', adminName: 'roman' }
const REGISTRATION: ProbeInitiator = { trigger: 'registration' }

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-status-store-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function statusStore(overrides: { readonly now?: () => number } = {}) {
  return createServerStatusStore({
    journalDir,
    probingFreshForMs: PROBING_FRESH_FOR_MS,
    now: overrides.now ?? (() => T0),
  })
}

describe('empty document', () => {
  test('getStatus of an unknown server reads as never-checked', async () => {
    const store = statusStore()

    expect(await store.getStatus('github')).toEqual({ status: 'never-checked' })
  })

  test('listStatuses starts empty', async () => {
    const store = statusStore()

    expect(await store.listStatuses()).toEqual({})
  })
})

describe('probe lifecycle transitions', () => {
  test('beginProbe writes a probing entry with start time and initiator', async () => {
    const store = statusStore()

    const begun = await store.beginProbe('github', { initiator: LAZY })

    expect(begun.status).toBe('started')
    expect(await store.getStatus('github')).toEqual({
      status: 'probing',
      probeStartedAt: new Date(T0).toISOString(),
      initiator: LAZY,
    })
  })

  test('recordResult transitions probing to alive with latency and via', async () => {
    const store = statusStore()
    await store.beginProbe('github', { initiator: LAZY })

    await store.recordResult(
      'github',
      { status: 'alive', probedVia: 'initialize', initializeLatencyMs: 42 },
      { initiator: LAZY },
    )

    expect(await store.getStatus('github')).toEqual({
      status: 'alive',
      probedVia: 'initialize',
      initializeLatencyMs: 42,
      probedAt: new Date(T0).toISOString(),
      initiator: LAZY,
    })
  })

  test.each(['error', 'unreachable', 'vault-refused'] as const)(
    'recordResult transitions probing to %s and stores the (pre-redacted) message verbatim',
    async (status) => {
      const store = statusStore()
      await store.beginProbe('github', { initiator: REFRESH })

      await store.recordResult('github', { status, error: 'redacted: token <name>' }, { initiator: REFRESH })

      expect(await store.getStatus('github')).toEqual({
        status,
        error: 'redacted: token <name>',
        probedAt: new Date(T0).toISOString(),
        initiator: REFRESH,
      })
    },
  )

  test('a later probe overwrites a settled result', async () => {
    const store = statusStore()
    await store.beginProbe('github', { initiator: LAZY })
    await store.recordResult(
      'github',
      { status: 'unreachable', error: 'connect timed out' },
      { initiator: LAZY },
    )

    const later = statusStore({ now: () => T0 + PROBING_FRESH_FOR_MS + 1 })
    const begun = await later.beginProbe('github', { initiator: REFRESH })

    expect(begun.status).toBe('started')
    const current = await store.getStatus('github')
    expect(current.status).toBe('probing')
  })
})

describe('probing as cross-process dedup marker', () => {
  test('a fresh probing entry refuses a second writer and stays intact', async () => {
    const first = statusStore()
    await first.beginProbe('github', { initiator: LAZY })

    const second = statusStore({ now: () => T0 + PROBING_FRESH_FOR_MS - 1 })
    const begun = await second.beginProbe('github', { initiator: REFRESH })

    expect(begun).toEqual({
      status: 'already-probing',
      entry: { status: 'probing', probeStartedAt: new Date(T0).toISOString(), initiator: LAZY },
    })
    // The refused writer changed nothing: the first probe's marker survives.
    expect(await first.getStatus('github')).toEqual({
      status: 'probing',
      probeStartedAt: new Date(T0).toISOString(),
      initiator: LAZY,
    })
  })

  test('a stale probing entry (crashed prober) is taken over', async () => {
    const crashed = statusStore()
    await crashed.beginProbe('github', { initiator: LAZY })

    const takeoverAt = T0 + PROBING_FRESH_FOR_MS
    const second = statusStore({ now: () => takeoverAt })
    const begun = await second.beginProbe('github', { initiator: REFRESH })

    expect(begun.status).toBe('started')
    expect(await second.getStatus('github')).toEqual({
      status: 'probing',
      probeStartedAt: new Date(takeoverAt).toISOString(),
      initiator: REFRESH,
    })
  })
})

describe('lazy cleanup against the registry name list', () => {
  test('a write scoped to registryNames drops entries for servers gone from the registry', async () => {
    const store = statusStore()
    await store.beginProbe('removed-server', { initiator: LAZY })
    await store.beginProbe('github', { initiator: LAZY })

    await store.recordResult(
      'github',
      { status: 'alive', probedVia: 'tools/list', initializeLatencyMs: 7 },
      { initiator: LAZY, registryNames: ['github', 'other'] },
    )

    expect(await store.getStatus('removed-server')).toEqual({ status: 'never-checked' })
    expect(Object.keys(await store.listStatuses())).toEqual(['github'])
  })

  test('cleanup never drops the server being written, even if absent from the list', async () => {
    const store = statusStore()

    await store.beginProbe('github', { initiator: REGISTRATION, registryNames: [] })

    expect((await store.getStatus('github')).status).toBe('probing')
  })

  test('a write without registryNames leaves foreign entries alone', async () => {
    const store = statusStore()
    await store.beginProbe('removed-server', { initiator: LAZY })

    await store.beginProbe('github', { initiator: LAZY })

    expect((await store.getStatus('removed-server')).status).toBe('probing')
  })
})

describe('concurrency and persistence', () => {
  test('concurrent results from two handles both land (rev-CAS retry)', async () => {
    const a = statusStore()
    const b = statusStore()
    await a.beginProbe('alpha', { initiator: LAZY })
    await b.beginProbe('beta', { initiator: REFRESH })

    await Promise.all([
      a.recordResult('alpha', { status: 'alive', probedVia: 'initialize', initializeLatencyMs: 5 }, { initiator: LAZY }),
      b.recordResult('beta', { status: 'error', error: 'bad handshake' }, { initiator: REFRESH }),
    ])

    expect((await a.getStatus('alpha')).status).toBe('alive')
    expect((await a.getStatus('beta')).status).toBe('error')
  })

  test('the document survives reopening the store', async () => {
    const store = statusStore()
    await store.beginProbe('github', { initiator: LAZY })
    await store.recordResult(
      'github',
      { status: 'alive', probedVia: 'initialize', initializeLatencyMs: 42 },
      { initiator: LAZY },
    )

    const reopened = statusStore()

    expect(await reopened.getStatus('github')).toEqual({
      status: 'alive',
      probedVia: 'initialize',
      initializeLatencyMs: 42,
      probedAt: new Date(T0).toISOString(),
      initiator: LAZY,
    })
  })

  test('status writes never touch the registry document', async () => {
    const store = statusStore()
    await store.beginProbe('github', { initiator: LAZY })
    await store.recordResult(
      'github',
      { status: 'alive', probedVia: 'initialize', initializeLatencyMs: 1 },
      { initiator: LAZY, registryNames: ['github'] },
    )

    expect(await createRegistryStore(journalDir).listServers()).toEqual([])
  })
})

describe('write validation (a bad write must not corrupt the document)', () => {
  test('rejects a hostile server name instead of persisting it', async () => {
    const store = statusStore()

    await expect(store.beginProbe('__proto__', { initiator: LAZY })).rejects.toBeInstanceOf(
      InvalidStatusServerNameError,
    )
    await expect(store.beginProbe('Bad Name', { initiator: LAZY })).rejects.toBeInstanceOf(
      InvalidStatusServerNameError,
    )
  })

  test('rejects an invalid result payload instead of persisting it', async () => {
    const store = statusStore()
    await store.beginProbe('github', { initiator: LAZY })

    await expect(
      store.recordResult(
        'github',
        { status: 'alive', probedVia: 'initialize', initializeLatencyMs: Number.NaN },
        { initiator: LAZY },
      ),
    ).rejects.toBeInstanceOf(InvalidStatusWriteError)
    // The probing marker written before the bad result is still intact.
    expect((await store.getStatus('github')).status).toBe('probing')
  })
})
