import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAdminStore, type AdminStore } from '../../src/admin/store.js'
import { ROUTE_TABLE, roleSatisfies, type RouteEntry, type Role } from '../../src/ui/authz.js'
import { REQUIRED_HANDLER_KEYS, type UiHandlers } from '../../src/ui/routes.js'
import { createUiServer, type UiServer, type UiServerOptions } from '../../src/ui/server.js'
import { createLoginRateLimiter } from '../../src/ui/auth.js'
import { CONTENT_SECURITY_POLICY, SESSIONS_PER_ADMIN_MAX } from '../../src/ui/constants.js'

/**
 * Origin a browser would attach to every POST from a page of this UI. The
 * server requires it on state-changing requests; any localhost origin passes
 * the allowlist, so the port does not need to match the ephemeral one.
 */
const UI_TEST_ORIGIN = 'http://127.0.0.1'

/**
 * Hardening tests for the admin UI HTTP core (M4 Task 9) — written before the
 * implementation. They pin the security surface: deny-by-default authz across
 * every route × role, no existence oracle, CSRF, security headers, DNS
 * rebinding, login rate limiting, session TTL, session-kill on
 * rotate/remove/role, and the no-token-leak marker.
 */

interface WarnCapture {
  readonly lines: string[]
  write(chunk: string): boolean
}

function warnCapture(): WarnCapture {
  const lines: string[] = []
  return { lines, write: (chunk: string) => (lines.push(chunk), true) }
}

/** Records every response body so the marker test can scan them all. */
const seenBodies: string[] = []

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

let mutableNow = Date.UTC(2026, 7, 11, 12, 0, 0)

interface Started {
  readonly base: string
  readonly server: UiServer
  readonly adminStore: AdminStore
  readonly warn: WarnCapture
  readonly tokens: Record<Role, string>
  login(token: string): Promise<{ cookie: string; csrf: string; status: number }>
  dispose(): Promise<void>
}

async function startUi(overrides: Partial<UiServerOptions> = {}): Promise<Started> {
  const journalDir = mkdtempSync(join(tmpdir(), 'mcp-ui-hardening-'))
  const adminStore = createAdminStore({ journalDir })
  const created = await adminStore.createAdmin('owner-admin', 'owner')
  const opCreated = await adminStore.createAdmin('op-admin', 'operator')
  const viewCreated = await adminStore.createAdmin('view-admin', 'viewer')
  const tokens: Record<Role, string> = {
    owner: created.token,
    operator: opCreated.token,
    viewer: viewCreated.token,
  }
  const warn = warnCapture()
  const server = createUiServer({ adminStore, handlers: stubHandlers(), stderr: warn, ...overrides })
  const { port } = await server.listen(0)
  const base = `http://127.0.0.1:${port}`

  /**
   * A successful login answers 303 → `/` (review M-2), so the cookie is read
   * off the redirect and the CSRF token off the page it points at — the stub
   * handlers echo it where the real layout puts `<meta name="csrf-token">`.
   */
  async function login(token: string): Promise<{ cookie: string; csrf: string; status: number }> {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      // A browser always sends Origin on a POST, and the server now requires it.
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ token }),
      redirect: 'manual',
    })
    const setCookie = res.headers.get('set-cookie') ?? ''
    const cookie = setCookie.split(';')[0] ?? ''
    seenBodies.push(await res.text())
    if (res.status !== 303) return { cookie, csrf: '', status: res.status }
    const page = await fetch(`${base}/`, { headers: { cookie } })
    const pageText = await page.text()
    seenBodies.push(pageText)
    return { cookie, csrf: /csrf:(\S*)/.exec(pageText)?.[1] ?? '', status: res.status }
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

/** Concrete path for a route pattern (`:id` → `x`, `*` → `app.js`). */
function pathFor(entry: RouteEntry): string {
  return entry.pattern
    .split('/')
    .map((segment) => {
      if (segment === '*') return 'app.js'
      if (segment.startsWith(':')) return 'x'
      return segment
    })
    .join('/')
}

const ROLES: readonly Role[] = ['owner', 'operator', 'viewer']

/** Raw GET (bypasses `fetch`'s forbidden-header list) returning the status code. */
function rawGetStatus(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

let started: Started | null = null

afterEach(async () => {
  await started?.dispose()
  started = null
})

describe('deny-by-default role matrix (every route × every role × no session)', () => {
  test('unlisted routes are 403 for everyone including owner and no session', async () => {
    started = await startUi()
    const { cookie } = await started.login(started.tokens.owner)
    for (const target of ['/nope', '/admins/nope', '/api/secret']) {
      const anon = await fetch(`${started.base}${target}`)
      expect(anon.status).toBe(403)
      const asOwner = await fetch(`${started.base}${target}`, { headers: { cookie } })
      expect(asOwner.status).toBe(403)
    }
  })

  test('protected routes: role below minRole → 403, at/above → not 403, no session → 403', async () => {
    started = await startUi()
    const cookies: Record<Role, { cookie: string; csrf: string }> = {
      owner: await started.login(started.tokens.owner),
      operator: await started.login(started.tokens.operator),
      viewer: await started.login(started.tokens.viewer),
    }

    for (const entry of ROUTE_TABLE) {
      if (entry.minRole === 'public') continue
      // Skip logout: exercising it would destroy the session mid-matrix.
      if (entry.handler === '@logout') continue
      const path = pathFor(entry)
      const minRole = entry.minRole

      // No session. Oracle fix: a missing session yields the SAME byte-identical
      // 403 as an unlisted route (no more 302→/login for GET vs 403 for
      // unlisted), so a protected route cannot be enumerated without a session.
      // The single exception is the root path, which is not a secret.
      if (!(entry.method === 'GET' && entry.pattern === '/')) {
        const anon = await fetch(`${started.base}${path}`, { method: entry.method, redirect: 'manual' })
        expect(anon.status, `no session → ${entry.method} ${path}`).toBe(403)
      }

      // Each role.
      for (const role of ROLES) {
        const { cookie, csrf } = cookies[role]
        const headers: Record<string, string> = { cookie }
        if (entry.method === 'POST') {
          headers['x-csrf-token'] = csrf
          headers.origin = UI_TEST_ORIGIN
        }
        const res = await fetch(`${started.base}${path}`, {
          method: entry.method,
          headers,
          redirect: 'manual',
        })
        seenBodies.push(await res.text())
        if (roleSatisfies(role, minRole)) {
          expect(res.status, `${role} → ${entry.method} ${path}`).not.toBe(403)
          expect(res.status, `${role} → ${entry.method} ${path}`).not.toBe(401)
        } else {
          expect(res.status, `${role} → ${entry.method} ${path}`).toBe(403)
        }
      }
    }
  })

  test('viewer is refused on every POST route', async () => {
    started = await startUi()
    const { cookie, csrf } = await started.login(started.tokens.viewer)
    // Every POST route a viewer is NOT entitled to (logout is a viewer action).
    const postRoutes = ROUTE_TABLE.filter(
      (entry) =>
        entry.method === 'POST' &&
        entry.minRole !== 'public' &&
        !roleSatisfies('viewer', entry.minRole),
    )
    for (const entry of postRoutes) {
      const res = await fetch(`${started.base}${pathFor(entry)}`, {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': csrf, origin: UI_TEST_ORIGIN },
      })
      expect(res.status, `viewer POST ${entry.pattern}`).toBe(403)
    }
  })

  test('operator is refused on owner-only routes', async () => {
    started = await startUi()
    const { cookie, csrf } = await started.login(started.tokens.operator)
    const ownerRoutes = ROUTE_TABLE.filter((entry) => entry.minRole === 'owner')
    for (const entry of ownerRoutes) {
      const headers: Record<string, string> = { cookie }
      if (entry.method === 'POST') headers['x-csrf-token'] = csrf
      const res = await fetch(`${started.base}${pathFor(entry)}`, {
        method: entry.method,
        headers,
        redirect: 'manual',
      })
      expect(res.status, `operator ${entry.method} ${entry.pattern}`).toBe(403)
    }
  })
})

describe('no session', () => {
  test('every protected route (incl. POST) is a uniform 403 without a cookie', async () => {
    started = await startUi()
    for (const entry of ROUTE_TABLE) {
      if (entry.minRole === 'public') continue
      // `GET /` is the one deliberate exception: it redirects to `/login`.
      // The path is not a secret (every visitor types it), so it leaks nothing
      // — see the landing-page describe above.
      if (entry.method === 'GET' && entry.pattern === '/') continue
      const res = await fetch(`${started.base}${pathFor(entry)}`, {
        method: entry.method,
        redirect: 'manual',
      })
      // Same 403 as an unlisted route: no existence oracle for the anonymous.
      expect(res.status, `no session → ${entry.method} ${entry.pattern}`).toBe(403)
    }
  })

  test('public routes are reachable without a session', async () => {
    started = await startUi()
    const loginPage = await fetch(`${started.base}/login`, { redirect: 'manual' })
    expect(loginPage.status).toBe(200)
    const asset = await fetch(`${started.base}/assets/app.js`, { redirect: 'manual' })
    expect(asset.status).toBe(200)
  })
})

describe('login credential handling', () => {
  test('a wrong token and a non-existent token are byte-identical 401s', async () => {
    started = await startUi()
    const wrong = await fetch(`${started.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: UI_TEST_ORIGIN },
      body: JSON.stringify({ token: 'mcpa_wrongwrongwrong' }),
    })
    const missing = await fetch(`${started.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: UI_TEST_ORIGIN },
      body: JSON.stringify({}),
    })
    expect(wrong.status).toBe(401)
    expect(missing.status).toBe(401)
    const a = Buffer.from(await wrong.arrayBuffer())
    const b = Buffer.from(await missing.arrayBuffer())
    expect(a.equals(b)).toBe(true)
  })

  test('N failed logins → 429 and a warn line', async () => {
    started = await startUi({ loginMaxFailures: 3, loginWindowMs: 60_000 })
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${started.base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: UI_TEST_ORIGIN },
        body: JSON.stringify({ token: 'mcpa_bad' }),
      })
      expect(res.status).toBe(401)
    }
    const blocked = await fetch(`${started.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: UI_TEST_ORIGIN },
      body: JSON.stringify({ token: 'mcpa_bad' }),
    })
    expect(blocked.status).toBe(429)
    expect(started.warn.lines.some((line) => line.includes('rate limit'))).toBe(true)
  })
})

describe('login rate limiting is per client, not global (M-1)', () => {
  // The server keys the window by `req.socket.remoteAddress`; every test client
  // here shares 127.0.0.1, so the keying itself is exercised at the limiter.
  test('failures from one address do not lock out another', () => {
    const limiter = createLoginRateLimiter({ maxFailures: 3, windowMs: 60_000 })
    for (let i = 0; i < 5; i += 1) limiter.recordFailure('10.0.0.1')

    expect(limiter.allow('10.0.0.1')).toBe(false)
    expect(limiter.allow('10.0.0.2')).toBe(true)
  })

  test('a successful login clears only that address window', () => {
    const limiter = createLoginRateLimiter({ maxFailures: 2, windowMs: 60_000 })
    limiter.recordFailure('10.0.0.1')
    limiter.recordFailure('10.0.0.1')
    limiter.recordFailure('10.0.0.2')
    limiter.recordFailure('10.0.0.2')

    limiter.recordSuccess('10.0.0.1')

    expect(limiter.allow('10.0.0.1')).toBe(true)
    expect(limiter.allow('10.0.0.2')).toBe(false)
  })

  test('the window slides: failures older than it stop counting', () => {
    let now = 1_000_000
    const limiter = createLoginRateLimiter({ maxFailures: 2, windowMs: 1000, clock: () => now })
    limiter.recordFailure('10.0.0.1')
    limiter.recordFailure('10.0.0.1')
    expect(limiter.allow('10.0.0.1')).toBe(false)

    now += 2000

    expect(limiter.allow('10.0.0.1')).toBe(true)
  })

  test('the global ceiling throttles a distributed flood without refusing anyone', () => {
    const limiter = createLoginRateLimiter({
      maxFailures: 3,
      globalMaxFailures: 10,
      windowMs: 60_000,
    })
    for (let i = 0; i < 10; i += 1) limiter.recordFailure(`10.0.0.${i}`)

    // This test used to assert `allow(...) === false` here. That expectation was
    // wrong, not merely strict: a ceiling keyed on nothing is a lockout anyone
    // who can reach `/login` can pull (127.0.0.0/8 aliases suffice), which is
    // the ROADMAP "global login ceiling as a lockout primitive" finding. The
    // flood is now paid for in latency instead — same throughput cost to the
    // attacker, no denial to a legitimate admin.
    expect(limiter.allow('10.0.0.250')).toBe(true)
    expect(limiter.penaltyMs('10.0.0.250')).toBeGreaterThan(0)
  })

  test('the tracked-key map is bounded and forgets the least-recently-seen', () => {
    const limiter = createLoginRateLimiter({ maxFailures: 1, maxKeys: 2, windowMs: 60_000 })
    limiter.recordFailure('a')
    limiter.recordFailure('b')
    limiter.recordFailure('c')

    // 'a' was pushed out — forgiveness, never a lockout of an untouched client.
    expect(limiter.allow('a')).toBe(true)
    expect(limiter.allow('c')).toBe(false)
  })
})

describe('session caps (M-4)', () => {
  test('one admin cannot hold more than the per-admin cap of sessions', async () => {
    started = await startUi({ maxSessions: 64 })
    const opened: string[] = []
    for (let i = 0; i < SESSIONS_PER_ADMIN_MAX; i += 1) {
      const result = await started.login(started.tokens.owner)
      expect(result.status, `login #${i + 1}`).toBe(303)
      opened.push(result.cookie)
    }

    const refused = await started.login(started.tokens.owner)

    expect(refused.status).toBe(429)
    // Every earlier session of that admin is still usable.
    for (const cookie of opened) {
      const res = await fetch(`${started.base}/`, { headers: { cookie }, redirect: 'manual' })
      expect(res.status).toBe(200)
      await res.text()
    }
  })

  test('another admin is unaffected by a peer at the per-admin cap', async () => {
    started = await startUi()
    for (let i = 0; i < SESSIONS_PER_ADMIN_MAX; i += 1) {
      await started.login(started.tokens.viewer)
    }
    expect((await started.login(started.tokens.viewer)).status).toBe(429)

    expect((await started.login(started.tokens.owner)).status).toBe(303)
  })
})

describe('CSRF', () => {
  test('a POST without a CSRF token is 403 even with a valid session', async () => {
    started = await startUi()
    const { cookie } = await started.login(started.tokens.operator)
    const res = await fetch(`${started.base}/approvals/x/approve`, { method: 'POST', headers: { cookie } })
    expect(res.status).toBe(403)
  })

  test('a POST with a wrong CSRF token is 403', async () => {
    started = await startUi()
    const { cookie } = await started.login(started.tokens.operator)
    const res = await fetch(`${started.base}/approvals/x/approve`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': 'not-the-token', origin: UI_TEST_ORIGIN },
    })
    expect(res.status).toBe(403)
  })
})

describe('security headers', () => {
  test('every response carries the exact CSP, nosniff and no-referrer', async () => {
    started = await startUi()
    const { cookie } = await started.login(started.tokens.viewer)
    for (const res of [
      await fetch(`${started.base}/`, { headers: { cookie } }),
      await fetch(`${started.base}/nope`),
      await fetch(`${started.base}/login`),
    ]) {
      expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      // MUST be same-origin, never no-referrer: per the Fetch spec, a document
      // under `Referrer-Policy: no-referrer` serializes the Origin header of
      // its form POSTs as `null` — which our own Origin screening rejects,
      // locking every Chromium browser out of /login (found by manual smoke
      // 2026-08-11, docs/smoke-m4.md).
      expect(res.headers.get('referrer-policy')).toBe('same-origin')
      await res.text()
    }
  })
})

describe('DNS rebinding (Host/Origin)', () => {
  test('a foreign Host is 403 before authentication', async () => {
    started = await startUi()
    const { cookie } = await started.login(started.tokens.owner)
    // `fetch` forbids overriding the Host header, so use a raw request.
    const port = Number(new URL(started.base).port)
    const status = await rawGetStatus(port, '/', { host: 'evil.com', cookie })
    expect(status).toBe(403)
  })

  test('a foreign Origin is 403', async () => {
    started = await startUi()
    const { cookie } = await started.login(started.tokens.owner)
    const res = await fetch(`${started.base}/`, {
      headers: { cookie, origin: 'https://evil.com' },
    })
    expect(res.status).toBe(403)
  })
})

describe('the unauthenticated landing page (smoke M4: a bare 403)', () => {
  test('an anonymous GET / redirects to /login', async () => {
    started = await startUi()

    const res = await fetch(`${started.base}/`, { redirect: 'manual' })

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/login')
    await res.text()
  })

  test('every OTHER protected route still answers the byte-identical 403', async () => {
    started = await startUi()

    // The redirect is scoped to exactly `/` and nothing else. Redirecting any
    // protected path would restore the enumeration oracle the 403 exists to
    // close: 303 for a listed route vs 403 for an unlisted one tells an
    // anonymous caller which routes exist.
    for (const path of ['/journal', '/servers', '/agents', '/vault', '/nope']) {
      const res = await fetch(`${started.base}${path}`, { redirect: 'manual' })
      expect(res.status, `anonymous GET ${path}`).toBe(403)
      await res.text()
    }
  })

  test('an authenticated GET / still renders the app', async () => {
    started = await startUi()
    const { cookie } = await started.login(started.tokens.viewer)

    const res = await fetch(`${started.base}/`, { headers: { cookie }, redirect: 'manual' })

    expect(res.status).toBe(200)
    await res.text()
  })
})

describe('Origin is mandatory on every state-changing request', () => {
  test('a POST without an Origin header is 403, even with valid credentials', async () => {
    started = await startUi()

    // A browser ALWAYS sends Origin on a POST. A POST without one did not come
    // from the UI's own pages, so the CSRF story (SameSite + double-submit)
    // never had to be relied on alone.
    const res = await fetch(`${started.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: started.tokens.owner }),
      redirect: 'manual',
    })

    expect(res.status).toBe(403)
  })

  test('a POST with the listener own origin is served', async () => {
    started = await startUi()

    const res = await fetch(`${started.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: started.base },
      body: JSON.stringify({ token: started.tokens.owner }),
      redirect: 'manual',
    })

    expect(res.status).toBe(303)
  })

  test('a GET without an Origin header is unaffected', async () => {
    started = await startUi()

    // Typing the URL into the address bar sends no Origin; requiring one on
    // reads would make the UI unusable without changing any attacker's options.
    const res = await fetch(`${started.base}/login`)

    expect(res.status).toBe(200)
    await res.text()
  })
})

describe('cookie and transport hardening behind TLS', () => {
  test('with --behind-tls the session cookie carries the __Host- prefix and Secure', async () => {
    started = await startUi({ behindTls: true })

    const res = await fetch(`${started.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: started.base },
      body: JSON.stringify({ token: started.tokens.owner }),
      redirect: 'manual',
    })
    const setCookie = res.headers.get('set-cookie') ?? ''

    // `__Host-` is enforced by the browser: only a secure origin may set it, it
    // must be Path=/ with no Domain, so no sibling subdomain can overwrite the
    // session cookie of the admin plane.
    expect(setCookie).toContain('__Host-')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).not.toContain('Domain=')
    await res.text()
  })

  test('a __Host- cookie is accepted behind TLS and the plain name is not', async () => {
    started = await startUi({ behindTls: true })
    const login = await started.login(started.tokens.owner)
    expect(login.status).toBe(303)
    const [name, value] = login.cookie.split('=') as [string, string]
    expect(name.startsWith('__Host-')).toBe(true)

    const good = await fetch(`${started.base}/journal`, { headers: { cookie: login.cookie } })
    expect(good.status).toBe(200)
    await good.text()

    // The same session id under the unprefixed name must NOT authenticate: a
    // subdomain can set that one, and accepting both would hand back exactly
    // the fixation `__Host-` exists to prevent.
    // Asserted on `/journal`: the root path redirects an unauthenticated
    // visitor to `/login` by design, which would pass for the wrong reason.
    const stripped = await fetch(`${started.base}/journal`, {
      headers: { cookie: `mcp_admin_session=${value}` },
      redirect: 'manual',
    })
    expect(stripped.status).toBe(403)
    await stripped.text()
  })

  test('with --behind-tls every response carries HSTS', async () => {
    started = await startUi({ behindTls: true })

    const res = await fetch(`${started.base}/login`)

    expect(res.headers.get('strict-transport-security')).toContain('max-age=')
    await res.text()
  })

  test('without --behind-tls there is no HSTS and no __Host- prefix', async () => {
    started = await startUi()

    const res = await fetch(`${started.base}/login`)

    // Sending HSTS over plain loopback HTTP would be inert at best and, if the
    // UI is ever reached by a name shared with real sites, would pin that name
    // to HTTPS for a year from a page that does not serve it.
    expect(res.headers.get('strict-transport-security')).toBeNull()
    await res.text()

    const login = await started.login(started.tokens.owner)
    expect(login.cookie.startsWith('mcp_admin_session=')).toBe(true)
  })
})

describe('session lifecycle', () => {
  test('a session expires after its TTL', async () => {
    mutableNow = Date.UTC(2026, 7, 11, 12, 0, 0)
    started = await startUi({ sessionTtlMs: 1000, clock: () => mutableNow })
    const { cookie } = await started.login(started.tokens.viewer)
    const before = await fetch(`${started.base}/journal`, { headers: { cookie }, redirect: 'manual' })
    expect(before.status).toBe(200)
    await before.text()
    mutableNow += 2000
    const after = await fetch(`${started.base}/journal`, { headers: { cookie }, redirect: 'manual' })
    // An expired session is indistinguishable from none: uniform 403. Asserted
    // on `/journal`, not `/` — the root path redirects to `/login` by design,
    // which would prove nothing about the session either way.
    expect(after.status).toBe(403)
  })

  test('rotate kills that admin session; other admins keep theirs', async () => {
    started = await startUi()
    const op = await started.login(started.tokens.operator)
    const viewer = await started.login(started.tokens.viewer)
    await started.adminStore.rotateAdmin('op-admin')

    const opRes = await fetch(`${started.base}/journal`, {
      headers: { cookie: op.cookie },
      redirect: 'manual',
    })
    expect(opRes.status).toBe(403)
    const viewerRes = await fetch(`${started.base}/journal`, {
      headers: { cookie: viewer.cookie },
      redirect: 'manual',
    })
    expect(viewerRes.status).toBe(200)
    await viewerRes.text()
  })

  test('remove kills that admin session', async () => {
    started = await startUi()
    const op = await started.login(started.tokens.operator)
    await started.adminStore.removeAdmin('op-admin')
    const res = await fetch(`${started.base}/journal`, {
      headers: { cookie: op.cookie },
      redirect: 'manual',
    })
    expect(res.status).toBe(403)
  })

  test('a role change kills the existing session (role mismatch)', async () => {
    started = await startUi()
    const viewer = await started.login(started.tokens.viewer)
    await started.adminStore.setRole('view-admin', 'operator')
    const res = await fetch(`${started.base}/journal`, {
      headers: { cookie: viewer.cookie },
      redirect: 'manual',
    })
    expect(res.status).toBe(403)
  })
})

describe('token leak marker', () => {
  test('no admin token appears in any collected response body or warn log', async () => {
    started = await startUi()
    const owner = await started.login(started.tokens.owner)
    // Exercise a spread of endpoints.
    await (await fetch(`${started.base}/`, { headers: { cookie: owner.cookie } })).text()
    await (await fetch(`${started.base}/admins`, { headers: { cookie: owner.cookie } })).text()
    await (await fetch(`${started.base}/nope`)).text()

    const allText = seenBodies.join('\n') + '\n' + started.warn.lines.join('\n')
    for (const token of Object.values(started.tokens)) {
      expect(allText.includes(token)).toBe(false)
    }
  })
})
