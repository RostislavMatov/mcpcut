import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createAgentsStore } from '../../src/agents/store.js'
import { createRegistryStore } from '../../src/registry/store.js'
import { createVaultStore } from '../../src/vault/store.js'
import type { ProbeInitiator, ServerStatus } from '../../src/probe/status-schema.js'
import { createServersHandlers } from '../../src/ui/handlers/servers.js'
import {
  createServersStatusHandlers,
  type ServerStatusPort,
} from '../../src/ui/handlers/servers-status.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'
import { startUiHarness, type UiTestHarness } from './harness.js'

/**
 * Wave-2 Task 6 (M5.5 п.1, ADR-0008): the UI's probe seam. Handler-level
 * tests drive `serversPage`/`serversAdd`/`serversRefresh` against a FAKE
 * status port (the composition in `cli/ui-wiring.ts` binds the real
 * orchestrator); the composed-harness tests drive the real `runUi` over a
 * socket so the route row, CSRF, roles and the SSE fan-out are the
 * production ones.
 */

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const FAKE_SERVER_FIXTURE = join(FIXTURES_DIR, 'fake-server.mjs')

// ---------------------------------------------------------------------------
// Handler-level: fake status port
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly kind: 'ensureFresh' | 'probeNow'
  readonly names: readonly string[]
  readonly initiator: ProbeInitiator
}

interface FakePort {
  readonly calls: RecordedCall[]
  readonly reads: string[]
  readonly port: ServerStatusPort
}

function fakePort(overrides: Partial<ServerStatusPort> = {}): FakePort {
  const calls: RecordedCall[] = []
  const reads: string[] = []
  const port: ServerStatusPort = {
    ensureFresh: async (names, initiator) => {
      calls.push({ kind: 'ensureFresh', names: [...names], initiator })
    },
    probeNow: async (name, initiator) => {
      calls.push({ kind: 'probeNow', names: [name], initiator })
      return { status: 'never-checked' } satisfies ServerStatus
    },
    listStatuses: async () => {
      reads.push('listStatuses')
      return {}
    },
    lastSuccessfulActivity: async (serverName) => {
      reads.push(`activity:${serverName}`)
      return null
    },
    ...overrides,
  }
  return { calls, reads, port }
}

interface Harness {
  readonly dir: string
  readonly registry: ReturnType<typeof createRegistryStore>
  makeHandlers(port: ServerStatusPort): ReturnType<typeof createServersHandlers>
  dispose(): void
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ui-servers-status-'))
  const registry = createRegistryStore(dir)
  const agents = createAgentsStore({ journalDir: dir })
  const vault = createVaultStore({ journalDir: dir })
  return {
    dir,
    registry,
    makeHandlers: (port) => createServersHandlers({ registry, agents, vault, probes: port }),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const VIEWER = { adminName: 'vera', role: 'viewer' as const, csrfToken: 'csrf-1' }
const OWNER = { adminName: 'olga', role: 'owner' as const, csrfToken: 'csrf-2' }
const OPERATOR = { adminName: 'oleg', role: 'operator' as const, csrfToken: 'csrf-3' }

function getCtx(overrides: Partial<UiRequestContext> = {}): UiRequestContext {
  return {
    method: 'GET',
    path: '/servers',
    params: {},
    query: new URLSearchParams(),
    session: VIEWER,
    body: Buffer.alloc(0),
    headers: {},
    ...overrides,
  }
}

function formPost(
  pairs: Record<string, string>,
  path: string,
  session: UiRequestContext['session'],
): UiRequestContext {
  const body = Buffer.from(new URLSearchParams(pairs).toString(), 'utf8')
  return getCtx({
    method: 'POST',
    path,
    body,
    session,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
}

function asResponse(result: UiResult): Extract<UiResult, { kind: 'response' }> {
  if (result.kind !== 'response') throw new Error('expected a buffered response')
  return result
}

let h: Harness | null = null
afterEach(() => {
  h?.dispose()
  h = null
})

describe('GET /servers: instant render + lazy trigger (O2/O5)', () => {
  test('the page renders immediately even while ensureFresh never settles', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'alpha', transport: 'stdio', command: 'node' })
    // ensureFresh hangs forever — a slow (or stuck) probe engine must not
    // block the page: the handler starts it and does NOT await it.
    const { calls, port } = fakePort({
      ensureFresh: (names, initiator) => {
        calls.push({ kind: 'ensureFresh', names: [...names], initiator })
        return new Promise<never>(() => undefined)
      },
    })
    const handlers = h.makeHandlers(port)

    const res = asResponse(await handlers.serversPage(getCtx()))

    expect(res.status).toBe(200)
    expect(calls.filter((call) => call.kind === 'ensureFresh')).toHaveLength(1)
  })

  test('a viewer view still triggers ensureFresh, attributed to the viewer (O5)', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'alpha', transport: 'stdio', command: 'node' })
    await h.registry.addServer({ name: 'beta', transport: 'stdio', command: 'node' })
    const { calls, port } = fakePort()
    const handlers = h.makeHandlers(port)

    await handlers.serversPage(getCtx({ session: VIEWER }))

    const lazy = calls.filter((call) => call.kind === 'ensureFresh')
    expect(lazy).toHaveLength(1)
    expect([...(lazy[0]?.names ?? [])].sort()).toEqual(['alpha', 'beta'])
    expect(lazy[0]?.initiator).toEqual({ trigger: 'lazy', adminName: 'vera' })
  })

  test('the render consults the status store and the passive signal for every server', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'alpha', transport: 'stdio', command: 'node' })
    await h.registry.addServer({ name: 'beta', transport: 'stdio', command: 'node' })
    const { reads, port } = fakePort()
    const handlers = h.makeHandlers(port)

    await handlers.serversPage(getCtx())

    expect(reads).toContain('listStatuses')
    expect(reads).toContain('activity:alpha')
    expect(reads).toContain('activity:beta')
  })
})

describe('POST /servers/add: automatic registration probe (O8)', () => {
  test('a confirmed add fires one registration probe, attributed, after the registry write', async () => {
    h = makeHarness()
    const harness = h
    let recordPresentAtProbe: boolean | null = null
    const { calls, port } = fakePort()
    const probingPort: ServerStatusPort = {
      ...port,
      probeNow: async (name, initiator) => {
        calls.push({ kind: 'probeNow', names: [name], initiator })
        recordPresentAtProbe = (await harness.registry.getServer(name)) !== undefined
        return { status: 'never-checked' }
      },
    }
    const handlers = h.makeHandlers(probingPort)

    const res = asResponse(
      await handlers.serversAdd(
        formPost(
          { name: 'gamma', transport: 'stdio', command: 'node', confirm: 'true' },
          '/servers/add',
          OWNER,
        ),
      ),
    )

    expect(res.status).toBe(303)
    await vi.waitFor(() => {
      const probes = calls.filter((call) => call.kind === 'probeNow')
      expect(probes).toHaveLength(1)
      expect(probes[0]?.names).toEqual(['gamma'])
      expect(probes[0]?.initiator).toEqual({ trigger: 'registration', adminName: 'olga' })
      expect(recordPresentAtProbe).toBe(true)
    })
  })

  test('a rejected add never probes', async () => {
    h = makeHarness()
    const { calls, port } = fakePort()
    const handlers = h.makeHandlers(port)

    const res = asResponse(
      await handlers.serversAdd(
        formPost({ name: 'gamma', transport: 'stdio', confirm: 'true' }, '/servers/add', OWNER),
      ),
    )

    expect(res.status).toBe(400)
    expect(calls.filter((call) => call.kind === 'probeNow')).toHaveLength(0)
  })
})

/** A refresh request as the flat route delivers it: the name in the form body. */
function refreshCtx(name: string | undefined): UiRequestContext {
  return formPost(name === undefined ? {} : { name }, '/servers/refresh', OPERATOR)
}

describe('POST /servers/refresh handler', () => {
  test('a missing name is a clear 400, an unknown name a clear 404 — never a 500', async () => {
    const { calls, port } = fakePort()
    const handlers = createServersStatusHandlers({
      probes: port,
      hasServer: async (name) => name === 'alpha',
    })

    const missing = asResponse(await handlers.serversRefresh(refreshCtx(undefined)))
    expect(missing.status).toBe(400)

    const unknown = asResponse(await handlers.serversRefresh(refreshCtx('nope')))
    expect(unknown.status).toBe(404)
    expect(unknown.body).toContain('unknown server')
    expect(calls.filter((call) => call.kind === 'probeNow')).toHaveLength(0)
  })

  test('a known name fires a refresh probe with the admin attribution and redirects', async () => {
    const { calls, port } = fakePort()
    const handlers = createServersStatusHandlers({
      probes: port,
      hasServer: async () => true,
    })

    const res = asResponse(await handlers.serversRefresh(refreshCtx('alpha')))

    expect(res.status).toBe(303)
    expect(res.headers?.location).toBe('/servers')
    await vi.waitFor(() => {
      const probes = calls.filter((call) => call.kind === 'probeNow')
      expect(probes).toHaveLength(1)
      expect(probes[0]?.names).toEqual(['alpha'])
      expect(probes[0]?.initiator).toEqual({ trigger: 'refresh', adminName: 'oleg' })
    })
  })

  test('a probe that rejects after the redirect never fails the request', async () => {
    const { port } = fakePort({
      probeNow: () => Promise.reject(new Error('engine exploded')),
    })
    const handlers = createServersStatusHandlers({
      probes: port,
      hasServer: async () => true,
    })

    const res = asResponse(await handlers.serversRefresh(refreshCtx('alpha')))

    expect(res.status).toBe(303)
    // Give the rejected promise a tick: an uncaught rejection here would
    // crash the worker and fail the file.
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
})

// ---------------------------------------------------------------------------
// Composed UI over a real socket: roles, CSRF, SSE
// ---------------------------------------------------------------------------

describe('composed UI: refresh route and the SSE status event', () => {
  let started: UiTestHarness | null = null
  let composedDir: string | null = null

  afterEach(async () => {
    await started?.stop()
    started = null
    if (composedDir !== null) rmSync(composedDir, { recursive: true, force: true })
    composedDir = null
  })

  async function startWithServer(): Promise<UiTestHarness> {
    composedDir = mkdtempSync(join(tmpdir(), 'mcp-ui-servers-status-composed-'))
    const registry = createRegistryStore(composedDir)
    await registry.addServer({
      name: 'fake',
      transport: 'stdio',
      command: process.execPath,
      args: [FAKE_SERVER_FIXTURE],
    })
    started = await startUiHarness({ journalDir: composedDir })
    return started
  }

  test('refresh is operator+ with mandatory CSRF; unknown name is a 404', async () => {
    const ui = await startWithServer()

    const viewer = await ui.login('ui-viewer')
    expect((await viewer.post('/servers/refresh', { name: 'fake' })).status).toBe(403)

    const operator = await ui.login('ui-operator')
    expect((await operator.postWithoutCsrf('/servers/refresh', { name: 'fake' })).status).toBe(403)
    expect((await operator.post('/servers/refresh', { name: 'nope' })).status).toBe(404)

    const ok = await operator.post('/servers/refresh', { name: 'fake' })
    expect(ok.status).toBe(303)
    expect(ok.headers.location).toBe('/servers')
  }, 20_000)

  test('a settled probe reaches every SSE subscriber as server-status-changed', async () => {
    const ui = await startWithServer()
    const operator = await ui.login('ui-operator')
    const viewer = await ui.login('ui-viewer')
    const operatorStream = await ui.openSse(operator)
    const viewerStream = await ui.openSse(viewer)

    const res = await operator.post('/servers/refresh', { name: 'fake' })
    expect(res.status).toBe(303)

    await operatorStream.waitFor('server-status-changed', 15_000)
    await viewerStream.waitFor('server-status-changed', 15_000)
    const payload = operatorStream.text()
    expect(payload).toContain('"server":"fake"')
    expect(payload).toContain('"status":"alive"')
    expect(payload).toContain('"probedAt"')
    expect(payload).toContain('"latencyMs"')

    operatorStream.close()
    viewerStream.close()
  }, 20_000)
})
