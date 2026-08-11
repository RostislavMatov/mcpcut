import { mkdtempSync, rmSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAdminStore, type AdminStore } from '../../src/admin/store.js'
import { REQUIRED_HANDLER_KEYS, type UiHandlers } from '../../src/ui/routes.js'
import { createUiServer, type UiServer, type UiServerOptions } from '../../src/ui/server.js'
import { CONTENT_SECURITY_POLICY, SESSION_COOKIE_NAME } from '../../src/ui/constants.js'

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
      body: `handler:${key} admin:${ctx.session?.adminName ?? 'anon'} csrf:${ctx.session?.csrfToken ?? ''}`,
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

  /**
   * A successful login answers 303 → `/` with the session cookie; the CSRF
   * token is not in that response at all (it would land in browser history) —
   * it reaches the client in the destination page. The stub handlers echo it,
   * standing in for the layout's `<meta name="csrf-token">`.
   */
  async function login(token: string): Promise<{ cookie: string; csrf: string; status: number }> {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      redirect: 'manual',
    })
    await res.text()
    const setCookie = res.headers.get('set-cookie') ?? ''
    const cookie = setCookie.split(';')[0] ?? ''
    if (res.status !== 303) return { cookie, csrf: '', status: res.status }
    const page = await fetch(`${base}/`, { headers: { cookie } })
    const csrf = /csrf:(\S*)/.exec(await page.text())?.[1] ?? ''
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
  // Review M-2: a successful login used to answer a JSON document, which the
  // plain HTML form (`pages/login.ts`) dead-ends on, and which carried the CSRF
  // token into the browser's history. It is a 303 to a page instead.
  test('a valid token redirects to the app with an HttpOnly SameSite=Strict cookie', async () => {
    started = await startUi()
    const res = await fetch(`${started.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: started.tokens.owner }),
      redirect: 'manual',
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/')
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).not.toContain('Secure')
    expect(await res.text()).toBe('')
  })

  test('the login response carries no CSRF token; the page it lands on does', async () => {
    started = await startUi()
    const res = await fetch(`${started.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: started.tokens.owner }),
      redirect: 'manual',
    })
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(await res.text()).not.toContain('csrf')

    const page = await fetch(`${started.base}/`, { headers: { cookie } })
    const csrf = /csrf:(\S*)/.exec(await page.text())?.[1] ?? ''
    expect(csrf.length).toBeGreaterThan(20)
  })

  test('a browser following the redirect lands on an authenticated page', async () => {
    started = await startUi()
    const res = await fetch(`${started.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: started.tokens.viewer }),
      redirect: 'manual',
    })
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    await res.text()
    const landed = await fetch(`${started.base}${res.headers.get('location') ?? ''}`, {
      headers: { cookie },
    })
    expect(landed.status).toBe(200)
    expect(await landed.text()).toContain('handler:approvalsPage admin:view-admin')
  })

  test('--behind-tls adds Secure to the cookie', async () => {
    started = await startUi({ behindTls: true })
    const res = await fetch(`${started.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: started.tokens.owner }),
      redirect: 'manual',
    })
    await res.text()
    expect(res.headers.get('set-cookie') ?? '').toContain('Secure')
  })
})

describe('authenticated access', () => {
  test('a viewer session reaches a viewer page and carries attribution', async () => {
    started = await startUi()
    const { cookie } = await started.login(started.tokens.viewer)
    const res = await fetch(`${started.base}/`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('handler:approvalsPage admin:view-admin')
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

describe('session caps never evict a live session (M-4)', () => {
  test('past the global cap a new login is refused, and the existing sessions survive', async () => {
    started = await startUi({ maxSessions: 2 })
    const first = await started.login(started.tokens.owner)
    const second = await started.login(started.tokens.operator)
    expect(first.status).toBe(303)
    expect(second.status).toBe(303)

    const third = await started.login(started.tokens.viewer)

    expect(third.status).toBe(429)
    // The owner and operator sessions are untouched — this is the whole point:
    // a low-privilege token holder must not be able to sign an owner out.
    for (const cookie of [first.cookie, second.cookie]) {
      const res = await fetch(`${started.base}/`, { headers: { cookie }, redirect: 'manual' })
      expect(res.status).toBe(200)
      await res.text()
    }
    expect(started.warn.lines.some((line) => line.includes('session capacity'))).toBe(true)
  })

  test('a session freed by logout re-opens the slot', async () => {
    started = await startUi({ maxSessions: 1 })
    const first = await started.login(started.tokens.owner)
    expect((await started.login(started.tokens.viewer)).status).toBe(429)

    const out = await fetch(`${started.base}/logout`, {
      method: 'POST',
      headers: { cookie: first.cookie, 'x-csrf-token': first.csrf },
      redirect: 'manual',
    })
    expect(out.status).toBe(302)

    expect((await started.login(started.tokens.viewer)).status).toBe(303)
  })

  test('an expired session is reaped and does not block a new login', async () => {
    let now = Date.UTC(2026, 7, 11, 12, 0, 0)
    started = await startUi({ maxSessions: 1, sessionTtlMs: 1000, clock: () => now })
    expect((await started.login(started.tokens.owner)).status).toBe(303)
    expect((await started.login(started.tokens.viewer)).status).toBe(429)

    now += 2000

    expect((await started.login(started.tokens.viewer)).status).toBe(303)
  })
})

describe('handler headers cannot weaken the security headers (M-5)', () => {
  test('a handler-supplied CSP does not reach the response', async () => {
    const journalDir = mkdtempSync(join(tmpdir(), 'mcp-ui-headers-'))
    const adminStore = createAdminStore({ journalDir })
    const { token } = await adminStore.createAdmin('owner-admin', 'owner')
    const handlers: Record<string, UiHandlers[string]> = { ...stubHandlers() }
    for (const key of ['approvalsPage', 'assets', 'loginPage']) {
      handlers[key] = () => ({
        kind: 'response',
        status: 200,
        headers: {
          'content-security-policy': "default-src *; script-src 'unsafe-inline'",
          'x-content-type-options': 'off',
          'referrer-policy': 'unsafe-url',
          'x-frame-options': 'ALLOWALL',
          'cache-control': 'public, max-age=600',
        },
        body: 'hijacked',
      })
    }
    const server = createUiServer({ adminStore, handlers })
    try {
      const { port } = await server.listen(0)
      const base = `http://127.0.0.1:${port}`
      const loginRes = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
        redirect: 'manual',
      })
      await loginRes.text()
      const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

      for (const res of [
        await fetch(`${base}/`, { headers: { cookie } }),
        await fetch(`${base}/assets/app.js`),
        await fetch(`${base}/login`),
      ]) {
        expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY)
        expect(res.headers.get('x-content-type-options')).toBe('nosniff')
        expect(res.headers.get('referrer-policy')).toBe('same-origin')
        expect(res.headers.get('x-frame-options')).toBe('DENY')
        // Cache-control stays the handler's to choose (assets rely on it).
        expect(res.headers.get('cache-control')).toBe('public, max-age=600')
        await res.text()
      }
    } finally {
      await server.close()
      rmSync(journalDir, { recursive: true, force: true })
    }
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
