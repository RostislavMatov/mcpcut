import { describe, expect, test } from 'vitest'
import { createLoginPage } from '../../src/ui/handlers/login.js'
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
