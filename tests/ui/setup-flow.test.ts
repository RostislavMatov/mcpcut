import { mkdtempSync, rmSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { AdminRecord } from '../../src/admin/store.js'
import { createAdminStore, type AdminStore } from '../../src/admin/store.js'
import { REQUIRED_HANDLER_KEYS, type UiHandlers } from '../../src/ui/routes.js'
import { createUiServer, type UiServer, type UiServerOptions } from '../../src/ui/server.js'
import { createSetupGate, type SetupGate } from '../../src/ui/setup-gate.js'
import { AUDIT_RECORD_DROPPED_WARNING, SETUP_CODE_REFUSED_NOTICE } from '../../src/ui/constants.js'

/**
 * The first-run flow through the real HTTP core (ADR-0004, amendment of
 * 2026-09-19): an install with no admin serves `/setup`; the setup code plus
 * a name mint the owner, the token is shown once, and the page is gone.
 */

const ORIGIN = 'http://127.0.0.1'

function stubHandlers(): UiHandlers {
  const out: Record<string, UiHandlers[string]> = {}
  for (const key of REQUIRED_HANDLER_KEYS) {
    out[key] =
      key === 'events'
        ? () => ({ kind: 'stream', onStream: (res: ServerResponse) => res.end() })
        : (ctx) => ({ kind: 'response', status: 200, body: `handler:${key} admin:${ctx.session?.adminName ?? 'anon'}` })
  }
  return out
}

interface Started {
  readonly base: string
  readonly server: UiServer
  readonly adminStore: AdminStore
  readonly gate: SetupGate
  readonly code: string
  readonly created: AdminRecord[]
  readonly warnings: string[]
}

let journalDir: string | undefined
let server: UiServer | undefined

async function startFirstRun(
  overrides: Partial<UiServerOptions> = {},
  afterOwnerCreated?: (admin: AdminRecord) => Promise<{ written: boolean }>,
): Promise<Started> {
  journalDir = mkdtempSync(join(tmpdir(), 'mcp-ui-setup-'))
  const adminStore = createAdminStore({ journalDir })
  const gate = createSetupGate({ hasAdmins: async () => (await adminStore.listAdmins()).length > 0 })
  const code = gate.arm()
  const created: AdminRecord[] = []
  const warnings: string[] = []
  server = createUiServer({
    adminStore,
    handlers: stubHandlers(),
    stderr: { write: (chunk: string) => warnings.push(chunk) },
    firstRun: {
      gate,
      createFirstOwner: (name) => adminStore.createFirstOwner(name),
      afterOwnerCreated:
        afterOwnerCreated ??
        (async (admin) => {
          created.push(admin)
          return { written: true }
        }),
    },
    ...overrides,
  })
  const { port } = await server.listen(0)
  return { base: `http://127.0.0.1:${port}`, server, adminStore, gate, code, created, warnings }
}

function postSetup(base: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(`${base}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, accept: 'text/html', ...headers },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  })
}

afterEach(async () => {
  await server?.close()
  server = undefined
  if (journalDir !== undefined) rmSync(journalDir, { recursive: true, force: true })
  journalDir = undefined
})

describe('an install with no admin', () => {
  test('sends a visitor of any page to /setup, and /login there too', async () => {
    const ui = await startFirstRun()

    for (const path of ['/', '/servers', '/no-such-page', '/login']) {
      const res = await fetch(`${ui.base}${path}`, { redirect: 'manual' })
      expect([path, res.status, res.headers.get('location')]).toEqual([path, 303, '/setup'])
    }
  })

  test('serves the form on GET /setup, uncacheable and under the security headers', async () => {
    const ui = await startFirstRun()

    const res = await fetch(`${ui.base}/setup`)

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-security-policy')).not.toBeNull()
    expect(await res.text()).toContain('<form method="post" action="/setup">')
  })

  test('keeps the page script a 401, not a redirect it would follow', async () => {
    const ui = await startFirstRun()

    const res = await fetch(`${ui.base}/api/approvals`, {
      headers: { 'x-requested-with': 'fetch' },
      redirect: 'manual',
    })

    expect(res.status).toBe(401)
  })

  test('the right code and a name create the owner, show the token once and close the page', async () => {
    const ui = await startFirstRun()

    const res = await postSetup(ui.base, { code: ui.code, name: 'alice' })
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const token = /<pre class="token" data-token>([^<]+)<\/pre>/.exec(body)?.[1] ?? ''
    expect(token.startsWith('mcpa_')).toBe(true)
    const admin = await ui.adminStore.findAdminByToken(token)
    expect([admin?.name, admin?.role]).toEqual(['alice', 'owner'])
    expect(ui.created.map((a) => a.name)).toEqual(['alice'])

    const again = await fetch(`${ui.base}/setup`, { redirect: 'manual' })
    expect([again.status, again.headers.get('location')]).toEqual([303, '/login'])
    const home = await fetch(`${ui.base}/`, { redirect: 'manual' })
    expect(home.headers.get('location')).toBe('/login')
  })

  test('the token it showed signs in', async () => {
    const ui = await startFirstRun()
    const body = await (await postSetup(ui.base, { code: ui.code, name: 'alice' })).text()
    const token = /data-token>([^<]+)</.exec(body)?.[1] ?? ''

    const login = await fetch(`${ui.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
      body: new URLSearchParams({ csrf_token: '', token }).toString(),
      redirect: 'manual',
    })

    expect(login.status).toBe(303)
    expect(login.headers.get('set-cookie')).toContain('=')
  })

  test('a wrong, missing or empty code is one uniform refusal that creates nobody', async () => {
    const ui = await startFirstRun()

    const bodies: string[] = []
    for (const fields of [{ code: 'mcps_wrong', name: 'alice' }, { name: 'alice' }, { code: '', name: 'alice' }]) {
      const res = await postSetup(ui.base, fields as Record<string, string>)
      expect(res.status).toBe(401)
      bodies.push(await res.text())
    }

    expect(new Set(bodies).size).toBe(1)
    expect(bodies[0]).toContain(SETUP_CODE_REFUSED_NOTICE)
    expect(bodies[0]).toContain('value="alice"')
    expect(bodies[0]).not.toContain('mcps_wrong')
    expect(await ui.adminStore.listAdmins()).toHaveLength(0)
  })

  test('a wrong code is refused BEFORE the name is looked at — no validation oracle without the code', async () => {
    const ui = await startFirstRun()

    const res = await postSetup(ui.base, { code: 'mcps_wrong', name: 'Not A Name' })

    expect(res.status).toBe(401)
    expect(await res.text()).toContain(SETUP_CODE_REFUSED_NOTICE)
  })

  test('the right code with an invalid name is a 400 that keeps the page open', async () => {
    const ui = await startFirstRun()

    const res = await postSetup(ui.base, { code: ui.code, name: 'Not A Name' })

    expect(res.status).toBe(400)
    expect(await res.text()).toContain('must match')
    expect(await ui.adminStore.listAdmins()).toHaveLength(0)
    expect(await ui.gate.isOpen()).toBe(true)
  })

  test('attempts are rate-limited per address, and a refusal past the limit is a 429', async () => {
    const ui = await startFirstRun({ loginMaxFailures: 2 })

    await postSetup(ui.base, { code: 'x', name: 'a' })
    await postSetup(ui.base, { code: 'x', name: 'a' })
    const third = await postSetup(ui.base, { code: ui.code, name: 'alice' })

    expect(third.status).toBe(429)
    expect(await ui.adminStore.listAdmins()).toHaveLength(0)
  })

  test('requires an Origin like every other POST', async () => {
    const ui = await startFirstRun()

    const res = await fetch(`${ui.base}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: ui.code, name: 'alice' }).toString(),
    })

    expect(res.status).toBe(403)
    expect(await ui.adminStore.listAdmins()).toHaveLength(0)
  })

  test('two concurrent claims with the right code make one owner', async () => {
    const ui = await startFirstRun()

    const [a, b] = await Promise.all([
      postSetup(ui.base, { code: ui.code, name: 'alice' }),
      postSetup(ui.base, { code: ui.code, name: 'bob' }),
    ])

    expect([a.status, b.status].sort()).toEqual([200, 303])
    expect(await ui.adminStore.listAdmins()).toHaveLength(1)
  })

  test('a dropped audit record is said on the token page itself, not only on stderr', async () => {
    const ui = await startFirstRun({}, async () => ({ written: false }))

    const body = await (await postSetup(ui.base, { code: ui.code, name: 'alice' })).text()

    expect(body).toContain('data-token')
    expect(body).toContain(AUDIT_RECORD_DROPPED_WARNING)
  })

  test('a written audit record earns no warning', async () => {
    const ui = await startFirstRun()

    const body = await (await postSetup(ui.base, { code: ui.code, name: 'alice' })).text()

    expect(body).not.toContain(AUDIT_RECORD_DROPPED_WARNING)
  })

  test('a JSON body works like the form does', async () => {
    const ui = await startFirstRun()

    const res = await fetch(`${ui.base}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ code: ui.code, name: 'alice' }),
    })

    expect(res.status).toBe(200)
    expect((await ui.adminStore.listAdmins()).map((a) => a.name)).toEqual(['alice'])
  })

  test('a body past the cap is a 413 that creates nobody', async () => {
    const ui = await startFirstRun({ maxBodyBytes: 64 })

    const res = await postSetup(ui.base, { code: ui.code, name: 'alice', pad: 'x'.repeat(200) }).catch(() => undefined)

    expect(res === undefined || res.status === 413).toBe(true)
    expect(await ui.adminStore.listAdmins()).toHaveLength(0)
  })

  test('a failing after-creation hook is a stderr line, never a lost token', async () => {
    const ui = await startFirstRun({}, async () => {
      throw new Error('journal \x1b[31mdown')
    })

    const res = await postSetup(ui.base, { code: ui.code, name: 'alice' })
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).toContain('data-token')
    // A hook that threw wrote no record either, and the page says so.
    expect(body).toContain(AUDIT_RECORD_DROPPED_WARNING)
    expect(ui.warnings.join('')).toContain('[ui] after first-owner setup:')
    expect(ui.warnings.join('')).not.toContain('\x1b')
  })
})

describe('a store that fails under the first-run page', () => {
  test('an unexpected failure to create the owner is a detail-free 500 that leaves the page open', async () => {
    journalDir = mkdtempSync(join(tmpdir(), 'mcp-ui-setup-'))
    const gate = createSetupGate({ hasAdmins: async () => false })
    const code = gate.arm()
    const warnings: string[] = []
    server = createUiServer({
      adminStore: createAdminStore({ journalDir }),
      handlers: stubHandlers(),
      stderr: { write: (chunk: string) => warnings.push(chunk) },
      firstRun: {
        gate,
        createFirstOwner: async () => {
          throw new Error('disk on fire at /srv/secret/path')
        },
      },
    })
    const { port } = await server.listen(0)

    const res = await postSetup(`http://127.0.0.1:${port}`, { code, name: 'alice' })

    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('/srv/secret/path')
    expect(warnings.join('')).toContain('[ui] request handler failed:')
    expect(await gate.isOpen()).toBe(true)
  })
})

describe('a store that stops answering while /setup is open', () => {
  test('pages point at /login instead of failing: no owner is offered beside unreadable records', async () => {
    journalDir = mkdtempSync(join(tmpdir(), 'mcp-ui-setup-'))
    const complaints: unknown[] = []
    const gate = createSetupGate({
      hasAdmins: async () => {
        throw new Error('state.db is corrupt')
      },
      onReadError: (error) => complaints.push(error),
    })
    const code = gate.arm()
    server = createUiServer({
      adminStore: createAdminStore({ journalDir }),
      handlers: stubHandlers(),
      stderr: { write: () => true },
      firstRun: { gate, createFirstOwner: async () => Promise.reject(new Error('must not be reached')) },
    })
    const { port } = await server.listen(0)
    const base = `http://127.0.0.1:${port}`

    const home = await fetch(`${base}/`, { redirect: 'manual' })
    const claim = await postSetup(base, { code, name: 'alice' })

    expect([home.status, home.headers.get('location')]).toEqual([303, '/login'])
    expect([claim.status, claim.headers.get('location')]).toEqual([303, '/login'])
    expect(complaints.length).toBeGreaterThanOrEqual(2)
  })
})

describe('an admin created elsewhere while /setup is open', () => {
  test('closes the page: the code no longer creates anyone', async () => {
    const ui = await startFirstRun()
    await ui.adminStore.createAdmin('cli-owner', 'owner')

    const res = await postSetup(ui.base, { code: ui.code, name: 'alice' })

    expect([res.status, res.headers.get('location')]).toEqual([303, '/login'])
    expect((await ui.adminStore.listAdmins()).map((a) => a.name)).toEqual(['cli-owner'])
  })
})

describe('a server built without the first-run option', () => {
  test('has no /setup: GET and POST both point at /login', async () => {
    journalDir = mkdtempSync(join(tmpdir(), 'mcp-ui-setup-'))
    const adminStore = createAdminStore({ journalDir })
    server = createUiServer({ adminStore, handlers: stubHandlers(), stderr: { write: () => true } })
    const { port } = await server.listen(0)
    const base = `http://127.0.0.1:${port}`

    const get = await fetch(`${base}/setup`, { redirect: 'manual' })
    const post = await postSetup(base, { code: 'x', name: 'alice' })

    expect([get.status, get.headers.get('location')]).toEqual([303, '/login'])
    expect([post.status, post.headers.get('location')]).toEqual([303, '/login'])
    expect(await adminStore.listAdmins()).toHaveLength(0)
  })
})
