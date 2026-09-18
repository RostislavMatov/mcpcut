import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { html } from '../../src/ui/html.js'
import { renderLayout } from '../../src/ui/pages/layout.js'
import { renderLoginPage } from '../../src/ui/pages/login.js'
import { startUiHarness, type UiTestHarness } from './harness.js'

/**
 * The sign-out affordance (post-M4.5 UI hardening, finding #1 of
 * `docs/smoke-ui-hardening.md`).
 *
 * `POST /logout` existed and worked from the first day of M4, but no page ever
 * rendered a control that reached it: the browser smoke found
 * `Array.from(document.forms)` empty on `/`. A session could therefore only end
 * by idle timeout (60 min), absolute TTL (8 h) or `mcpcut admin rotate` —
 * exactly the wrong answer on a shared workstation, which is the deployment the
 * control plane is built for.
 *
 * The control is deliberately a real `<form method="post">` and not a link:
 * `GET /logout` is not a route at all, and the server screens every state
 * change on Origin plus a double-submit CSRF token, which a link cannot carry.
 * It lives in the layout so it appears on every authenticated page and on none
 * of the pre-auth ones (`/login` renders with no `currentAdmin`).
 */

const CSRF_TOKEN = 'csrf-token-value'

const BASE_LAYOUT = {
  title: 'Approvals',
  content: html`<p>hello</p>`,
  csrfToken: CSRF_TOKEN,
}

const CURRENT_ADMIN = { name: 'alice', role: 'owner' }

/** Every `<form>…</form>` block in a document whose action is exactly `action`. */
function formsPosting(documentHtml: string, action: string): string[] {
  const forms = documentHtml.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? []
  return forms.filter((form) => new RegExp(`\\saction="${action}"`).test(form))
}

/** The hidden `name=value` pairs of one form block, as a browser would submit them. */
function hiddenFields(formHtml: string): Record<string, string> {
  const out: Record<string, string> = {}
  const pattern = /<input\b[^>]*type="hidden"[^>]*>/g
  for (const tag of formHtml.match(pattern) ?? []) {
    const name = /\sname="([^"]*)"/.exec(tag)?.[1]
    const value = /\svalue="([^"]*)"/.exec(tag)?.[1] ?? ''
    if (name !== undefined) out[name] = value
  }
  return out
}

describe('the layout renders a sign-out control for a signed-in admin', () => {
  test('an authenticated page carries exactly one POST form to /logout', () => {
    const document = renderLayout({ ...BASE_LAYOUT, currentAdmin: CURRENT_ADMIN })

    const forms = formsPosting(document, '/logout')
    expect(forms).toHaveLength(1)
    expect(forms[0] ?? '').toMatch(/method="post"/i)
  })

  test('the control is a submit button, not a link (GET /logout is not a route)', () => {
    const document = renderLayout({ ...BASE_LAYOUT, currentAdmin: CURRENT_ADMIN })

    const form = formsPosting(document, '/logout')[0] ?? ''
    expect(form).toMatch(/<button[^>]*type="submit"/)
    expect(document).not.toMatch(/<a[^>]*href="\/logout"/)
  })

  test('the form carries the layout’s CSRF token as the hidden csrf_token field', () => {
    const document = renderLayout({ ...BASE_LAYOUT, currentAdmin: CURRENT_ADMIN })

    const form = formsPosting(document, '/logout')[0] ?? ''
    expect(hiddenFields(form)).toEqual({ csrf_token: CSRF_TOKEN })
  })

  test('a hostile CSRF token is escaped inside the hidden field, not injected', () => {
    const document = renderLayout({
      ...BASE_LAYOUT,
      csrfToken: '"><script>alert(1)</script>',
      currentAdmin: CURRENT_ADMIN,
    })

    expect(document).not.toContain('<script>alert(1)</script>')
    const form = formsPosting(document, '/logout')[0] ?? ''
    expect(form).toContain('name="csrf_token"')
  })
})

describe('a pre-auth page never renders the sign-out control', () => {
  test('a layout rendered without currentAdmin has no logout form', () => {
    const document = renderLayout(BASE_LAYOUT)

    expect(formsPosting(document, '/logout')).toHaveLength(0)
  })

  test('the login page stays free of it', () => {
    // `/login` is rendered with no session at all, so a logout control there
    // could only ever produce a 403 — and would tell a visitor a session exists.
    expect(formsPosting(renderLoginPage(), '/logout')).toHaveLength(0)
  })
})

describe('the rendered control really ends the session (end to end)', () => {
  let tempDir: string | null = null
  let ui: UiTestHarness | null = null

  afterEach(async () => {
    await ui?.stop()
    ui = null
    if (tempDir !== null) await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  })

  test('submitting the form as a browser would drops the session and clears the cookie', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mcp-ui-logout-'))
    ui = await startUiHarness({ journalDir: tempDir })
    // A viewer is the lowest role there is: sign-out must not be an owner perk.
    const client = await ui.login('ui-viewer')

    const landing = await client.get('/')
    const form = formsPosting(landing.body, '/logout')[0] ?? ''
    expect(form, 'the live landing page renders no logout form').not.toBe('')

    // Submit exactly the fields the page itself rendered — no test-supplied token.
    const submitted = await client.postWithoutCsrf('/logout', hiddenFields(form))

    expect(submitted.status).toBe(302)
    expect(submitted.headers.location).toBe('/login')
    expect(String(submitted.headers['set-cookie'] ?? '')).toContain('Max-Age=0')
    // The cookie is gone from the browser, but the server-side session must be
    // gone too: replaying the old cookie is now an anonymous request.
    const replayed = await client.get('/')
    expect(replayed.status).toBe(303)
  })
})
