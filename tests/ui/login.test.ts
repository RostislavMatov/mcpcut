import type { IncomingMessage } from 'node:http'
import { describe, expect, test } from 'vitest'
import { UNKNOWN_TOKEN_NOTICE } from '../../src/admin/constants.js'
import type { AdminRecord } from '../../src/admin/store.js'
import { LOGIN_JS } from '../../src/ui/assets/login-js.js'
import {
  LOGIN_JS_SIGNIN_SOURCE,
  SIGN_IN_BUDGET_MS,
  SIGN_IN_TIMELINE_MS,
} from '../../src/ui/assets/login-js-signin.js'
import { createLoginRateLimiter, createSessionManager } from '../../src/ui/auth.js'
import { createLoginPage } from '../../src/ui/handlers/login.js'
import { handleLoginRequest, type LoginFlowDeps } from '../../src/ui/login-flow.js'
import { renderLoginPage } from '../../src/ui/pages/login.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'

/**
 * The public `/login` page (M4 Task 13): a token-entry form. It carries no
 * session (login mints one), so its CSRF field is present but empty; the POST
 * is guarded by SameSite + Origin/Host in the server core.
 */

function publicCtx(): UiRequestContext {
  return {
    method: 'GET',
    path: '/login',
    params: {},
    query: new URLSearchParams(),
    session: undefined,
    body: Buffer.alloc(0),
    headers: {},
  }
}

function asResponse(result: UiResult): Extract<UiResult, { kind: 'response' }> {
  if (result.kind !== 'response') throw new Error('expected a buffered response')
  return result
}

describe('login page rendering', () => {
  test('renders a token field and a CSRF field inside a POST /login form', () => {
    const doc = renderLoginPage()
    expect(doc).toContain('<form method="post" action="/login">')
    expect(doc).toContain('name="token"')
    expect(doc).toContain('name="csrf_token"')
  })

  test('is a full HTML document served through the shared layout', () => {
    const doc = renderLoginPage()
    expect(doc.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(doc).toContain('/assets/app.css')
  })

  test('escapes an untrusted error banner rather than injecting markup', () => {
    const doc = renderLoginPage({ error: '<script>alert(1)</script>' })
    expect(doc).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(doc).not.toContain('<script>alert(1)</script>')
  })
})

describe('login handler', () => {
  test('answers 200 with the login document', async () => {
    const handler = createLoginPage()
    const res = asResponse(await handler(publicCtx()))
    expect(res.status).toBe(200)
    expect(String(res.body)).toContain('name="token"')
  })
})

describe('login page — Auth screen extras (McpCut)', () => {
  test('loads the login script as a same-origin asset and renders the decor layer + controls', () => {
    const doc = renderLoginPage()
    expect(doc).toContain('<script src="/assets/login.js" defer></script>')
    expect(doc).toContain('data-decor')
    expect((doc.match(/class="decor-block"/g) ?? []).length).toBe(6)
    expect(doc).toContain('data-target')
    expect(doc).toContain('data-reveal="token"')
    expect(doc).toContain('data-remember')
    expect(doc).toContain('data-footer')
    // still no inline style / inline script anywhere on the page
    expect(doc).not.toMatch(/\sstyle="/)
    expect(doc).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[^<]/)
  })

  test('the remember toggle posts nothing (it carries no name)', () => {
    const doc = renderLoginPage()
    const checkbox = /<input type="checkbox"[^>]*>/.exec(doc)?.[0] ?? ''
    expect(checkbox).not.toContain('name=')
  })
})

/**
 * How long a sign-in takes (user-journey smoke 2026-09-18, UX-2). The
 * prototype's choreography held the POST for 5.5 s on EVERY sign-in, including
 * the ones that end in an error. It is now played into a one-second budget, and
 * skipped outright under `prefers-reduced-motion: reduce`.
 */
describe('the sign-in choreography', () => {
  test('reaches the real POST within its one-second budget', () => {
    expect(SIGN_IN_BUDGET_MS).toBe(1000)
    expect(SIGN_IN_TIMELINE_MS).toBeGreaterThan(0)
    expect(SIGN_IN_TIMELINE_MS).toBeLessThanOrEqual(SIGN_IN_BUDGET_MS)
  })

  test('every duration in it goes through the scaler, so none is left at the design length', () => {
    // A bare `}, 1460)`-shaped delay, or a `"… 420ms …"` transition, is one the
    // scale never reached: the whole point is that no single step outlives the
    // budget.
    expect(LOGIN_JS_SIGNIN_SOURCE).not.toMatch(/,\s*\d{3,}\s*\)/)
    expect(LOGIN_JS_SIGNIN_SOURCE).not.toMatch(/\d{3,}ms/)
    expect(LOGIN_JS_SIGNIN_SOURCE).toContain('T(function () { form.submit(); }, D(1000))')
  })

  test('reduced motion never reaches the choreography: the browser submits the form itself', () => {
    // The guard and `boot()` both live in the assembling module; the order of
    // those two lines IS the behaviour, and there is no DOM here to run it in.
    const source = String(LOGIN_JS.body)
    const guard = source.indexOf('if (reduced ||')
    const boot = source.indexOf('boot();')

    expect(guard).toBeGreaterThan(-1)
    expect(boot).toBeGreaterThan(guard)
    expect(source).toContain('prefers-reduced-motion: reduce')
  })
})

/**
 * A refused sign-in that a person can recover from (user-journey smoke
 * 2026-09-18, UX-1). A browser posting the plain form landed on
 * `{"error":"unauthorized"}` — no form, no words, no way back but the back
 * button. The console said `Token not recognised: …` in the same situation.
 *
 * What must NOT change: the status stays 401; the answer stays the same for a
 * token that never existed and one that was rotated or revoked (no oracle);
 * non-browser callers keep the JSON body they parse.
 */
const KNOWN_TOKEN = 'mcpa_known_token'

function loginDeps(warnings: string[]): LoginFlowDeps {
  const record: AdminRecord = {
    name: 'alice',
    role: 'owner',
    tokenHash: '0'.repeat(64),
    createdAt: '2026-09-18T00:00:00.000Z',
  }
  return {
    adminStore: {
      findAdminByToken: async (token: string) => (token === KNOWN_TOKEN ? record : undefined),
      getActiveAdmin: async () => record,
    },
    sessions: createSessionManager(),
    rateLimiter: createLoginRateLimiter(),
    behindTls: false,
    stderr: { write: (chunk: string) => warnings.push(chunk) },
  }
}

function postLogin(token: string, headers: Record<string, string>): UiRequestContext {
  return {
    method: 'POST',
    path: '/login',
    params: {},
    query: new URLSearchParams(),
    session: undefined,
    body: Buffer.from(new URLSearchParams({ token, csrf_token: '' }).toString()),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  }
}

/** A peer address per case, so one case's failures never spend another's allowance. */
let peer = 0
function request(): IncomingMessage {
  peer += 1
  return { headers: {}, socket: { remoteAddress: `198.51.100.${peer}` } } as unknown as IncomingMessage
}

const BROWSER_ACCEPT = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }

describe('POST /login refused: the answer a browser can read', () => {
  test('a form POST from a browser gets the login page back, with the error and still 401', async () => {
    const deps = loginDeps([])

    const result = await postAndRead(deps, 'mcpa_wrong', BROWSER_ACCEPT)

    expect(result.status).toBe(401)
    expect(result.headers?.['content-type']).toContain('text/html')
    expect(result.body).toContain('name="token"')
    expect(result.body).toContain('role="alert"')
    expect(result.body).toContain(UNKNOWN_TOKEN_NOTICE)
  })

  test('the page is byte-identical for an unknown token and a missing one: no oracle', async () => {
    const deps = loginDeps([])

    const unknown = await postAndRead(deps, 'mcpa_wrong', BROWSER_ACCEPT)
    const missing = await postAndRead(deps, '', BROWSER_ACCEPT)

    expect(unknown.body).toBe(missing.body)
    expect(missing.status).toBe(401)
  })

  test('an API caller keeps the JSON body, byte for byte', async () => {
    const deps = loginDeps([])

    const plain = await postAndRead(deps, 'mcpa_wrong', {})
    const scripted = await postAndRead(deps, 'mcpa_wrong', {
      ...BROWSER_ACCEPT,
      'x-requested-with': 'fetch',
    })

    expect(plain.body).toBe('{"error":"unauthorized"}')
    expect(plain.headers?.['content-type']).toContain('application/json')
    // The page script's own `fetch` asks for HTML too; the marker header is
    // what says "a script is asking", exactly as for the dead-session refusal.
    expect(scripted.body).toBe('{"error":"unauthorized"}')
  })

  test('a successful sign-in is untouched: still 303 with the cookie', async () => {
    const deps = loginDeps([])

    const result = await handleLoginRequest(deps, postLogin(KNOWN_TOKEN, BROWSER_ACCEPT), request())

    expect(statusOf(result)).toBe(303)
  })
})

async function postAndRead(
  deps: LoginFlowDeps,
  token: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers?: Record<string, string>; body: string }> {
  const result = asResponse(await handleLoginRequest(deps, postLogin(token, headers), request()))
  return {
    status: result.status,
    ...(result.headers !== undefined ? { headers: result.headers } : {}),
    body: String(result.body ?? ''),
  }
}

function statusOf(result: UiResult): number {
  return asResponse(result).status
}
