import { mkdtempSync, rmSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAdminStore, type AdminStore } from '../../src/admin/store.js'
import {
  CONSOLE_API_STATE_PATH,
  CONSOLE_API_WHOAMI_PATH,
  CONSOLE_API_SETUP_PATH,
  CONSOLE_API_RUN_PATH,
  consoleErrorSchema,
  consoleStateSchema,
  consoleWhoamiSchema,
  consoleSetupResponseSchema,
} from '../../src/console-api/contract.js'
import type { ConsoleRunner } from '../../src/console-api/runner.js'
import { REQUIRED_HANDLER_KEYS, type UiHandlers } from '../../src/ui/routes.js'
import { createUiServer, type UiServer, type UiServerOptions } from '../../src/ui/server.js'
import { createSetupGate, type SetupGate } from '../../src/ui/setup-gate.js'

/**
 * `/api/console/*` through the real HTTP core (ADR-0014, wave 1): the JSON
 * surface `mcpcut --remote <url>` speaks, on the same port as the browser UI
 * but through none of its cookie/CSRF machinery.
 */

function stubHandlers(): UiHandlers {
  const out: Record<string, UiHandlers[string]> = {}
  for (const key of REQUIRED_HANDLER_KEYS) {
    out[key] =
      key === 'events'
        ? () => ({ kind: 'stream', onStream: (res: ServerResponse) => res.end() })
        : () => ({ kind: 'response', status: 200, body: 'ok' })
  }
  return out
}

const NEVER_RUNNER: ConsoleRunner = () => {
  throw new Error('must not be reached by this suite')
}

let journalDir: string | undefined
let server: UiServer | undefined

async function start(overrides: Partial<UiServerOptions> = {}): Promise<{ base: string; adminStore: AdminStore }> {
  journalDir = mkdtempSync(join(tmpdir(), 'mcp-console-api-'))
  const adminStore = createAdminStore({ journalDir })
  server = createUiServer({
    adminStore,
    handlers: stubHandlers(),
    stderr: { write: () => true },
    consoleRunner: NEVER_RUNNER,
    ...overrides,
  })
  const { port } = await server.listen(0)
  return { base: `http://127.0.0.1:${port}`, adminStore }
}

async function startFirstRun(): Promise<{ base: string; adminStore: AdminStore; gate: SetupGate; code: string }> {
  journalDir = mkdtempSync(join(tmpdir(), 'mcp-console-api-'))
  const adminStore = createAdminStore({ journalDir })
  const gate = createSetupGate({ hasAdmins: async () => (await adminStore.listAdmins()).length > 0 })
  const code = gate.arm()
  server = createUiServer({
    adminStore,
    handlers: stubHandlers(),
    stderr: { write: () => true },
    consoleRunner: NEVER_RUNNER,
    firstRun: {
      gate,
      createFirstOwner: (name) => adminStore.createFirstOwner(name),
      afterOwnerCreated: async () => ({ written: true }),
    },
  })
  const { port } = await server.listen(0)
  return { base: `http://127.0.0.1:${port}`, adminStore, gate, code }
}

afterEach(async () => {
  await server?.close()
  server = undefined
  if (journalDir !== undefined) rmSync(journalDir, { recursive: true, force: true })
  journalDir = undefined
})

describe('GET /api/console/state', () => {
  test('is public: no admin exists yet, so firstRun is true', async () => {
    const ui = await startFirstRun()

    const res = await fetch(`${ui.base}${CONSOLE_API_STATE_PATH}`)
    const body = consoleStateSchema.parse(await res.json())

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(body).toEqual({ api: 1, firstRun: true })
  })

  test('reports firstRun false once an admin exists, and is uncacheable', async () => {
    const ui = await start()
    await ui.adminStore.createAdmin('alice', 'owner')

    const res = await fetch(`${ui.base}${CONSOLE_API_STATE_PATH}`)

    expect(consoleStateSchema.parse(await res.json())).toEqual({ api: 1, firstRun: false })
  })

  test('refuses any request carrying Origin, even a GET', async () => {
    const ui = await start()

    const res = await fetch(`${ui.base}${CONSOLE_API_STATE_PATH}`, {
      headers: { origin: 'http://evil.example' },
    })

    expect(res.status).toBe(403)
    expect(consoleErrorSchema.parse(await res.json()).error).toBe('forbidden')
  })
})

describe('POST /api/console/whoami', () => {
  test('a valid bearer resolves to its admin', async () => {
    const ui = await start()
    const created = await ui.adminStore.createAdmin('bob', 'operator')

    const res = await fetch(`${ui.base}${CONSOLE_API_WHOAMI_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.token}` },
    })

    expect(res.status).toBe(200)
    expect(consoleWhoamiSchema.parse(await res.json())).toEqual({ name: 'bob', role: 'operator' })
  })

  test('a missing, malformed or unknown token is one byte-identical 401', async () => {
    const ui = await start()
    await ui.adminStore.createAdmin('carol', 'viewer')

    const bodies: string[] = []
    for (const headers of [{}, { authorization: 'Basic xyz' }, { authorization: 'Bearer nope' }]) {
      const res = await fetch(`${ui.base}${CONSOLE_API_WHOAMI_PATH}`, { method: 'POST', headers })
      expect(res.status).toBe(401)
      bodies.push(await res.text())
    }

    expect(new Set(bodies).size).toBe(1)
    expect(consoleErrorSchema.parse(JSON.parse(bodies[0] as string)).error).toBe('unauthorized')
  })

  test('a revoked admin is refused the same as an unknown token', async () => {
    const ui = await start()
    await ui.adminStore.createAdmin('other-owner', 'owner')
    const created = await ui.adminStore.createAdmin('dana', 'viewer')
    await ui.adminStore.removeAdmin('dana')

    const res = await fetch(`${ui.base}${CONSOLE_API_WHOAMI_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.token}` },
    })

    expect(res.status).toBe(401)
  })

  test('refuses Origin the same as state does', async () => {
    const ui = await start()

    const res = await fetch(`${ui.base}${CONSOLE_API_WHOAMI_PATH}`, {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
    })

    expect(res.status).toBe(403)
  })

  test('a caller past its own rate-limit budget gets 429 rate-limited directly from whoami', async () => {
    journalDir = mkdtempSync(join(tmpdir(), 'mcp-console-api-'))
    const adminStore = createAdminStore({ journalDir })
    server = createUiServer({
      adminStore,
      handlers: stubHandlers(),
      stderr: { write: () => true },
      consoleRunner: NEVER_RUNNER,
      loginMaxFailures: 1,
    })
    const { port } = await server.listen(0)
    const base = `http://127.0.0.1:${port}`

    await fetch(`${base}${CONSOLE_API_WHOAMI_PATH}`, { method: 'POST', headers: { authorization: 'Bearer nope' } })
    const res = await fetch(`${base}${CONSOLE_API_WHOAMI_PATH}`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
    })

    expect(res.status).toBe(429)
    expect(consoleErrorSchema.parse(await res.json()).error).toBe('rate-limited')
  })

  test('shares the login rate limiter: a token guess against whoami spends the same budget as /login', async () => {
    journalDir = mkdtempSync(join(tmpdir(), 'mcp-console-api-'))
    const adminStore = createAdminStore({ journalDir })
    server = createUiServer({
      adminStore,
      handlers: stubHandlers(),
      stderr: { write: () => true },
      consoleRunner: NEVER_RUNNER,
      loginMaxFailures: 1,
    })
    const { port } = await server.listen(0)
    const base = `http://127.0.0.1:${port}`

    await fetch(`${base}${CONSOLE_API_WHOAMI_PATH}`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
    })
    const secondViaLogin = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1' },
      body: new URLSearchParams({ csrf_token: '', token: 'mcpa_nope' }).toString(),
      redirect: 'manual',
    })

    expect(secondViaLogin.status).toBe(429)
  })
})

describe('POST /api/console/setup', () => {
  test('the right code and a name mint the owner, once', async () => {
    const ui = await startFirstRun()

    const res = await fetch(`${ui.base}${CONSOLE_API_SETUP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: ui.code, name: 'alice' }),
    })
    const body = consoleSetupResponseSchema.parse(await res.json())

    expect(res.status).toBe(200)
    expect(body.name).toBe('alice')
    expect(body.token.startsWith('mcpa_')).toBe(true)
    expect(body.journaled).toBe(true)
    expect(await ui.gate.isOpen()).toBe(false)
  })

  test('a wrong code is code-refused, not unauthorized', async () => {
    const ui = await startFirstRun()

    const res = await fetch(`${ui.base}${CONSOLE_API_SETUP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'mcps_wrong', name: 'alice' }),
    })

    expect(res.status).toBe(401)
    expect(consoleErrorSchema.parse(await res.json()).error).toBe('code-refused')
    expect(await ui.adminStore.listAdmins()).toHaveLength(0)
  })

  test('an invalid name is invalid-name, not bad-request', async () => {
    const ui = await startFirstRun()

    const res = await fetch(`${ui.base}${CONSOLE_API_SETUP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: ui.code, name: 'Not A Name' }),
    })

    expect(res.status).toBe(400)
    expect(consoleErrorSchema.parse(await res.json()).error).toBe('invalid-name')
  })

  test('malformed JSON (not just a schema mismatch) is also bad-request', async () => {
    const ui = await startFirstRun()

    const res = await fetch(`${ui.base}${CONSOLE_API_SETUP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })

    expect(res.status).toBe(400)
    expect(consoleErrorSchema.parse(await res.json()).error).toBe('bad-request')
  })

  test('a malformed body is bad-request', async () => {
    const ui = await startFirstRun()

    const res = await fetch(`${ui.base}${CONSOLE_API_SETUP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'alice' }),
    })

    expect(res.status).toBe(400)
    expect(consoleErrorSchema.parse(await res.json()).error).toBe('bad-request')
  })

  test('a body past the server cap drops the connection rather than answering', async () => {
    journalDir = mkdtempSync(join(tmpdir(), 'mcp-console-api-'))
    const adminStore = createAdminStore({ journalDir })
    const gate = createSetupGate({ hasAdmins: async () => (await adminStore.listAdmins()).length > 0 })
    gate.arm()
    server = createUiServer({
      adminStore,
      handlers: stubHandlers(),
      stderr: { write: () => true },
      consoleRunner: NEVER_RUNNER,
      maxBodyBytes: 64,
      firstRun: {
        gate,
        createFirstOwner: (name) => adminStore.createFirstOwner(name),
        afterOwnerCreated: async () => ({ written: true }),
      },
    })
    const { port } = await server.listen(0)

    await expect(
      fetch(`http://127.0.0.1:${port}${CONSOLE_API_SETUP_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'x'.repeat(200), name: 'alice' }),
      }),
    ).rejects.toThrow()
  })

  test('once an admin exists (built without firstRun), setup answers closed', async () => {
    const ui = await start()

    const res = await fetch(`${ui.base}${CONSOLE_API_SETUP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'x', name: 'alice' }),
    })

    expect(res.status).toBe(409)
    expect(consoleErrorSchema.parse(await res.json()).error).toBe('closed')
  })

  test('an admin created elsewhere while the code is still live closes the window', async () => {
    const ui = await startFirstRun()
    await ui.adminStore.createAdmin('cli-owner', 'owner')

    const res = await fetch(`${ui.base}${CONSOLE_API_SETUP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: ui.code, name: 'alice' }),
    })

    expect(res.status).toBe(409)
    expect((await ui.adminStore.listAdmins()).map((a) => a.name)).toEqual(['cli-owner'])
  })
})

describe('an unmatched path under the prefix', () => {
  test('is a detail-free forbidden, not a 404 that names the path', async () => {
    const ui = await start()

    const res = await fetch(`${ui.base}/api/console/no-such-route`)

    expect(res.status).toBe(403)
    const body = consoleErrorSchema.parse(await res.json())
    expect(body.error).toBe('forbidden')
    expect(body.message).not.toContain('no-such-route')
  })

  test('a wrong method on a real path is the same detail-free forbidden', async () => {
    const ui = await start()

    const res = await fetch(`${ui.base}${CONSOLE_API_WHOAMI_PATH}`)

    expect(res.status).toBe(403)
  })
})

describe('a server built without a consoleRunner', () => {
  test('the whole prefix falls through unbranched, answered as any unlisted route', async () => {
    journalDir = mkdtempSync(join(tmpdir(), 'mcp-console-api-'))
    const adminStore = createAdminStore({ journalDir })
    server = createUiServer({ adminStore, handlers: stubHandlers(), stderr: { write: () => true } })
    const { port } = await server.listen(0)

    const res = await fetch(`http://127.0.0.1:${port}${CONSOLE_API_STATE_PATH}`, { redirect: 'manual' })

    // No session, no cookie: an unlisted route sends an unauthenticated
    // caller to /login, exactly like every other unlisted path.
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/login')
  })
})

describe('POST /api/console/run without a session (routing only; behaviour is console-run.test.ts)', () => {
  test('reaches the run handler, not a 403 unmatched route', async () => {
    journalDir = mkdtempSync(join(tmpdir(), 'mcp-console-api-'))
    const adminStore = createAdminStore({ journalDir })
    let called = false
    const runner: ConsoleRunner = async () => {
      called = true
      return 0
    }
    server = createUiServer({
      adminStore,
      handlers: stubHandlers(),
      stderr: { write: () => true },
      consoleRunner: runner,
    })
    const { port } = await server.listen(0)
    const created = await adminStore.createAdmin('eve', 'owner')

    await fetch(`http://127.0.0.1:${port}${CONSOLE_API_RUN_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ argv: ['status'] }),
    })

    expect(called).toBe(true)
  })
})
