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
