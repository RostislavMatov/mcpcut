import vm from 'node:vm'
import { describe, expect, test } from 'vitest'
import { APP_CSS } from '../../src/ui/assets/app-css.js'
import { APP_JS } from '../../src/ui/assets/app-js.js'
import { SILKSCREEN_400, SILKSCREEN_700 } from '../../src/ui/assets/fonts.js'
import { BRAND_NAME, CONTENT_SECURITY_POLICY } from '../../src/ui/constants.js'
import { createAssetsHandler } from '../../src/ui/handlers/assets.js'
import { html } from '../../src/ui/html.js'
import { renderLayout } from '../../src/ui/pages/layout.js'
import { renderLoginPage } from '../../src/ui/pages/login.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'

/**
 * The McpCut page shell (redesign 2026-08-22): the embedded pixel font, the
 * CSP directive that lets it load, the branded title, the role-gated tab bar
 * and the pre-auth login document that carries none of the authenticated
 * chrome. These are the cross-page contracts every page renderer inherits.
 */

function assetCtx(rest: string): UiRequestContext {
  return {
    method: 'GET',
    path: `/assets/${rest}`,
    params: { rest },
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

const CSS = String(APP_CSS.body)
const JS = String(APP_JS.body)

describe('embedded pixel font (Silkscreen, OFL)', () => {
  test('both faces are real woff2 binaries served from the asset allowlist', async () => {
    const handler = createAssetsHandler()
    for (const [name, asset] of [
      ['silkscreen-400.woff2', SILKSCREEN_400],
      ['silkscreen-700.woff2', SILKSCREEN_700],
    ] as const) {
      const res = asResponse(await handler(assetCtx(name)))
      expect(res.status).toBe(200)
      expect(res.headers?.['content-type']).toBe('font/woff2')
      expect(Buffer.isBuffer(res.body)).toBe(true)
      // woff2 magic number: 'wOF2'
      expect((res.body as Buffer).subarray(0, 4).toString('latin1')).toBe('wOF2')
      expect(res.headers?.etag).toBe(asset.etag)
    }
  })

  test('the stylesheet declares the faces by same-origin path only', () => {
    expect(CSS).toContain("font-family: 'Silkscreen'")
    expect(CSS).toContain('url(/assets/silkscreen-400.woff2)')
    expect(CSS).toContain('url(/assets/silkscreen-700.woff2)')
    expect(CSS).not.toMatch(/url\(\s*["']?https?:/)
    expect(CSS).not.toContain('fonts.googleapis.com')
    expect(CSS).not.toContain('fonts.gstatic.com')
  })

  test('the CSP allows same-origin fonts and nothing else for font-src', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("font-src 'self'")
    expect(CONTENT_SECURITY_POLICY).toMatch(/font-src 'self';/)
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'")
  })
})

describe('page shell — branding and navigation', () => {
  const admin = { name: 'alice', role: 'owner' }
  const base = { title: 'Servers', content: html`<p>body</p>`, csrfToken: 'tok' }

  test('the document title is suffixed with the brand constant', () => {
    const out = renderLayout({ ...base, currentAdmin: admin })
    expect(out).toContain(`<title>Servers · ${BRAND_NAME}</title>`)
    expect(out).toContain(`class="brand" href="/">${BRAND_NAME}</a>`)
  })

  test('an owner sees the owner-only tabs; an operator and a viewer do not', () => {
    const owner = renderLayout({ ...base, currentAdmin: admin })
    expect(owner).toContain('href="/admins"')
    expect(owner).toContain('href="/vault"')
    for (const role of ['operator', 'viewer']) {
      const doc = renderLayout({ ...base, currentAdmin: { name: 'bob', role } })
      expect(doc).not.toContain('href="/admins"')
      expect(doc).not.toContain('href="/vault"')
      expect(doc).toContain('href="/servers"')
      expect(doc).toContain('href="/journal"')
    }
  })

  test('the active tab carries aria-current and, when asked, a + action that targets a details id', () => {
    const out = renderLayout({
      ...base,
      currentAdmin: admin,
      activeNav: 'servers',
      navAction: { title: 'Register a server', targetId: 'add-server' },
      navMeta: '3 servers',
    })
    expect(out).toContain('<a class="tab" href="/servers" aria-current="page">Servers</a>')
    expect(out).toContain('href="#add-server"')
    expect(out).toContain('data-open-details="add-server"')
    expect(out).toContain('3 servers')
    // the client script understands the hook the shell emits
    expect(JS).toContain('data-open-details')
    expect(JS).toContain('data-close-details')
  })

  test('a search box is a real GET form; client-side filtering is an opt-in attribute the script reads', () => {
    const out = renderLayout({
      ...base,
      currentAdmin: admin,
      search: { action: '/journal', name: 'q', placeholder: 'search journal', value: 'a"b' },
    })
    expect(out).toContain('<form class="search" method="get" action="/journal" role="search">')
    expect(out).toContain('name="q" value="a&quot;b"')
    const client = renderLayout({
      ...base,
      currentAdmin: admin,
      search: { action: '/servers', name: 'q', placeholder: 'search', clientFilter: true },
    })
    expect(client).toContain('data-client-filter="1"')
    expect(JS).toContain('data-client-filter')
    expect(JS).toContain('data-filter-item')
  })

  test('the shell itself emits no inline style attribute (CSP style-src self)', () => {
    const out = renderLayout({ ...base, currentAdmin: admin, activeNav: 'servers' })
    expect(out).not.toMatch(/\sstyle="/)
  })
})

describe('login document — pre-auth chrome', () => {
  test('renders brand and token form but no tabs, no sign-out, no live channel', () => {
    const doc = renderLoginPage()
    expect(doc).toContain(BRAND_NAME)
    expect(doc).toContain('name="token"')
    expect(doc).not.toContain('class="tabs"')
    expect(doc).not.toContain('action="/logout"')
    expect(doc).not.toContain('data-events-url')
    expect(doc).toContain('class="page-login"')
  })

  test('the footer links are same-origin paths only', () => {
    const doc = renderLoginPage()
    const hrefs = [...doc.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? '')
    for (const href of hrefs) expect(href.startsWith('/')).toBe(true)
  })
})

describe('client script — the filter helpers really run (not just markup markers)', () => {
  /**
   * `APP_JS_SOURCE` is a non-raw template literal, so a regex escape written
   * as `\s` silently becomes `s` in the shipped asset (TS review of the McpCut
   * wave found `normalize()` shipped with `/s+/`). Substring checks on
   * attribute names cannot catch that; evaluating the helper can.
   */
  function helper(name: string): (...args: unknown[]) => unknown {
    const match = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`).exec(JS)
    if (match === null) throw new Error(`helper ${name} not found in app.js`)
    return vm.runInNewContext(`(${match[0].replace(`function ${name}`, 'function')})`) as (...args: unknown[]) => unknown
  }

  test('normalize() collapses real whitespace and lowercases', () => {
    const normalize = helper('normalize')
    expect(normalize('  Search \t SERVERS\nnow ')).toBe('search servers now')
    // the bug: `s` characters must survive (the regex must be \s, not s)
    expect(normalize('status')).toBe('status')
  })

  test('the shipped regex literally contains a backslash-s', () => {
    expect(JS).toContain('replace(/\\s+/g, " ")')
    expect(JS).not.toContain('replace(/s+/g')
  })
})
