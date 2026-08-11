import { mkdtempSync, rmSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAdminStore, type AdminStore } from '../../src/admin/store.js'
import { REQUIRED_HANDLER_KEYS, type UiHandlers } from '../../src/ui/routes.js'
import { createUiServer, type UiServer, type UiServerOptions } from '../../src/ui/server.js'
import { SESSION_COOKIE_NAME } from '../../src/ui/constants.js'

/**
 * Happy-path and contract tests for the admin UI HTTP core (M4 Task 9):
 * login → session → authorized page → logout, plus the injectable handler
 * contract. Security-oriented tables live in `ui-hardening.test.ts`.
 */

interface WarnCapture {
  readonly lines: string[]
  write(chunk: string): boolean
}

function warnCapture(): WarnCapture {
  const lines: string[] = []
  return { lines, write: (chunk: string) => (lines.push(chunk), true) }
}

/** A stub handler for every injected route, echoing its key and the caller. */
function stubHandlers(): UiHandlers {
  const out: Record<string, UiHandlers[string]> = {}
  for (const key of REQUIRED_HANDLER_KEYS) {
    if (key === 'events') {
      out[key] = () => ({ kind: 'stream', onStream: (res: ServerResponse) => res.end() })
      continue
    }
    out[key] = (ctx) => ({
      kind: 'response',
      status: 200,
      body: `handler:${key} admin:${ctx.session?.adminName ?? 'anon'}`,
    })
  }
  return out
}

interface Started {
  readonly base: string
  readonly server: UiServer
  readonly adminStore: AdminStore
  readonly warn: WarnCapture
  readonly tokens: Record<string, string>
  login(token: string): Promise<{ cookie: string; csrf: string; status: number }>
  dispose(): Promise<void>
}

async function startUi(overrides: Partial<UiServerOptions> = {}): Promise<Started> {
  const journalDir = mkdtempSync(join(tmpdir(), 'mcp-ui-server-'))
  const adminStore = createAdminStore({ journalDir })
  const tokens: Record<string, string> = {}
  ;({ token: tokens.owner } = await adminStore.createAdmin('owner-admin', 'owner'))
  ;({ token: tokens.operator } = await adminStore.createAdmin('op-admin', 'operator'))
  ;({ token: tokens.viewer } = await adminStore.createAdmin('view-admin', 'viewer'))
  const warn = warnCapture()
  const server = createUiServer({ adminStore, handlers: stubHandlers(), stderr: warn, ...overrides })
  const { port } = await server.listen(0)
  const base = `http://127.0.0.1:${port}`

  async function login(token: string): Promise<{ cookie: string; csrf: string; status: number }> {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const setCookie = res.headers.get('set-cookie') ?? ''
    const cookie = setCookie.split(';')[0] ?? ''
    const csrf = res.status === 200 ? ((await res.json()) as { csrfToken: string }).csrfToken : ''
    return { cookie, csrf, status: res.status }
  }

  return {
    base,
    server,
    adminStore,
    warn,
    tokens,
    login,
    dispose: async () => {
      await server.close()
      rmSync(journalDir, { recursive: true, force: true })
    },
  }
}

let started: Started | null = null

afterEach(async () => {
  await started?.dispose()
  started = null
})

describe('handler contract', () => {
  test('constructing without a handler for every route throws', async () => {
    const journalDir = mkdtempSync(join(tmpdir(), 'mcp-ui-incomplete-'))
    const adminStore = createAdminStore({ journalDir })
    try {
      expect(() =>
        createUiServer({ adminStore, handlers: { approvalsPage: () => ({ kind: 'response', status: 200 }) } }),
      ).toThrow(/missing handlers/i)
    } finally {
      rmSync(journalDir, { recursive: true, force: true })
    }
  })
})

describe('login', () => {
  test('a valid token sets an HttpOnly SameSite=Strict cookie and returns a csrf token', async () => {
    started = await startUi()
    const res = await fetch(`${started.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: started.tokens.owner }),
    })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).not.toContain('Secure')
    const csrf = ((await res.json()) as { csrfToken: string }).csrfToken
    expect(csrf.length).toBeGreaterThan(20)
  })

  test('--behind-tls adds Secure to the cookie', async () => {
    started = await startUi({ behindTls: true })
    const { cookie: _c } = await started.login(started.tokens.owner)
    const res = await fetch(`${started.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: started.tokens.owner }),
    })
    expect(res.headers.get('set-cookie') ?? '').toContain('Secure')
  })
})

describe('authenticated access', () => {
  test('a viewer session reaches a viewer page and carries attribution', async () => {
    started = await startUi()
    const { cookie } = await started.login(started.tokens.viewer)
    const res = await fetch(`${started.base}/`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('handler:approvalsPage admin:view-admin')
  })

  test('an operator can POST an operator action with a CSRF token', async () => {
    started = await startUi()
    const { cookie, csrf } = await started.login(started.tokens.operator)
    const res = await fetch(`${started.base}/approvals/abc/approve`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': csrf },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('handler:approvalsApprove')
  })

  test('logout clears the cookie and drops the session', async () => {
    started = await startUi()
    const { cookie, csrf } = await started.login(started.tokens.owner)
    expect(started.server.sessionCount()).toBe(1)
    const res = await fetch(`${started.base}/logout`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': csrf },
      redirect: 'manual',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie') ?? '').toContain('Max-Age=0')
    expect(started.server.sessionCount()).toBe(0)
  })
})

describe('SSE contract', () => {
  test('the events route returns a stream with SSE + security headers', async () => {
    started = await startUi()
    const { cookie } = await started.login(started.tokens.viewer)
    const res = await fetch(`${started.base}/events`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('content-security-policy')).toBeTruthy()
    await res.text()
  })
})
