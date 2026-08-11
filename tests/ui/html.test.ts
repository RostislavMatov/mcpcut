import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  escapeHtml,
  Html,
  html,
  join,
  raw,
  render,
  safeUrl,
} from '../../src/ui/html.js'
import { APP_CSS } from '../../src/ui/assets/app-css.js'
import { APP_JS } from '../../src/ui/assets/app-js.js'
import { renderLayout } from '../../src/ui/pages/layout.js'

/**
 * `html.ts` is the ONLY sanctioned path from data to HTML in the admin UI,
 * the exact analogue of "redaction is the only path to persistence". Every
 * interpolated value is escaped by default; the only way to opt out is to
 * already hold an `Html` built by this module. Content rendered here is
 * untrusted: tool names, descriptions and call arguments are controlled by
 * the proxied MCP server, and journal payloads come off disk. A single
 * unescaped interpolation is a stored/reflected XSS in a product that guards
 * other people's secrets.
 */

/** Interpolation points every fuzz payload is pushed through. */
const HOSTILE_PAYLOADS: readonly string[] = [
  '<script>alert(1)</script>',
  '"><script>alert(1)</script>',
  "'><img src=x onerror=alert(1)>",
  '<img src=x onerror=alert(1)>',
  '<svg/onload=alert(1)>',
  '</p><script>alert(1)</script><p>',
  '<scr<script>ipt>alert(1)</script>',
  '<img src=`x`onerror=alert(1)>',
  '<body onload=alert(1)>',
  '"><svg><script>alert(1)</script>',
  '&<>"\'',
  '&#60;script&#62;',
  '&amp;lt;script&amp;gt;',
  // unicode escapes decode to the same `<`/`>` chars — must still escape
  '<script>alert(1)</script>',
  // zero-width / BOM smuggling
  '﻿<script>alert(1)</script>',
  '​<img src=x onerror=alert(1)>',
  // homoglyph script tag (Greek rho etc.) — inert as text, must not break out
  'ϳ<script>alert(1)</script>',
  // NUL and control bytes
  '\x00<script>alert(1)</script>',
  '\x01\x02<img/src=x onerror=alert(1)>',
]

describe('escapeHtml', () => {
  test('escapes the five HTML-significant characters', () => {
    expect(escapeHtml('&')).toBe('&amp;')
    expect(escapeHtml('<')).toBe('&lt;')
    expect(escapeHtml('>')).toBe('&gt;')
    expect(escapeHtml('"')).toBe('&quot;')
    expect(escapeHtml("'")).toBe('&#39;')
  })

  test('escapes ampersand first so existing entities are neutralised, not decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  test('leaves plain text untouched', () => {
    expect(escapeHtml('create_issue')).toBe('create_issue')
  })
})

describe('html tagged template — escaping by default', () => {
  test('escapes <, >, &, " and \' interpolated into text', () => {
    const untrusted = `<>&"'`
    const out = render(html`<p>${untrusted}</p>`)
    expect(out).toBe('<p>&lt;&gt;&amp;&quot;&#39;</p>')
  })

  test('a <script> from a tool name becomes visible text, not an executable node', () => {
    const toolName = '<script>alert(document.cookie)</script>'
    const out = render(html`<h2>${toolName}</h2>`)
    expect(out).not.toContain('<script')
    expect(out).toContain('&lt;script&gt;')
  })

  test('interpolation into a quoted attribute cannot break out of the attribute', () => {
    const untrusted = '" onmouseover="alert(1)'
    const out = render(html`<span title="${untrusted}">x</span>`)
    // exactly the two delimiter quotes remain; the payload quote is escaped
    expect(out.match(/"/g)?.length).toBe(2)
    expect(out).not.toContain('onmouseover="alert')
    expect(out).toContain('&quot; onmouseover=&quot;alert(1)')
  })

  test('renders numbers and booleans safely', () => {
    expect(render(html`<b>${42}</b>`)).toBe('<b>42</b>')
    expect(render(html`<b>${true}</b>`)).toBe('<b>true</b>')
  })

  test('renders null and undefined as empty strings', () => {
    expect(render(html`<b>${null}${undefined}</b>`)).toBe('<b></b>')
  })

  test('nested html is inserted without double-escaping', () => {
    const inner = html`<b>${'<x>'}</b>`
    const out = render(html`<div>${inner}</div>`)
    expect(out).toBe('<div><b>&lt;x&gt;</b></div>')
  })

  test('an array of html fragments is concatenated', () => {
    const items = ['a', '<b>'].map((value) => html`<li>${value}</li>`)
    const out = render(html`<ul>${items}</ul>`)
    expect(out).toBe('<ul><li>a</li><li>&lt;b&gt;</li></ul>')
  })

  test('an array of untrusted strings is escaped element-wise', () => {
    const out = render(html`<p>${['<a>', '<b>']}</p>`)
    expect(out).toBe('<p>&lt;a&gt;&lt;b&gt;</p>')
  })
})

describe('raw — the checked escape hatch', () => {
  test('accepts html built by this module and returns it unchanged', () => {
    const fragment = html`<b>bold</b>`
    expect(render(raw(fragment))).toBe('<b>bold</b>')
  })

  test('a raw fragment interpolates without re-escaping', () => {
    const fragment = html`<em>ok</em>`
    expect(render(html`<div>${raw(fragment)}</div>`)).toBe('<div><em>ok</em></div>')
  })

  test('throws when handed a bare string (defeats `as any` / JS callers)', () => {
    // types forbid this; the runtime brand is the real guard once types erase
    expect(() => raw('<script>alert(1)</script>' as unknown as Html)).toThrow(TypeError)
  })

  test('throws when handed a plain object masquerading as html', () => {
    const fake = { toString: () => '<script>alert(1)</script>' }
    expect(() => raw(fake as unknown as Html)).toThrow(TypeError)
  })
})

describe('render', () => {
  test('rejects anything not built by html (no accidental string bodies)', () => {
    expect(() => render('<p>x</p>' as unknown as Html)).toThrow(TypeError)
  })
})

describe('safeUrl — scheme allowlist for href/src', () => {
  test('passes through http, https and mailto', () => {
    expect(safeUrl('https://example.com/x')).toBe('https://example.com/x')
    expect(safeUrl('http://127.0.0.1:8091/journal')).toBe('http://127.0.0.1:8091/journal')
    expect(safeUrl('mailto:ops@example.com')).toBe('mailto:ops@example.com')
  })

  test('passes through relative and fragment URLs', () => {
    expect(safeUrl('/approvals')).toBe('/approvals')
    expect(safeUrl('#top')).toBe('#top')
    expect(safeUrl('journal?session=abc')).toBe('journal?session=abc')
  })

  test('neutralises a javascript: URL', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('#')
  })

  test('neutralises case- and control-obfuscated javascript: URLs', () => {
    expect(safeUrl('JaVaScRiPt:alert(1)')).toBe('#')
    expect(safeUrl('java\tscript:alert(1)')).toBe('#')
    expect(safeUrl('  javascript:alert(1)')).toBe('#')
    expect(safeUrl('java\nscript:alert(1)')).toBe('#')
  })

  test('neutralises zero-width / unicode-space smuggling before the scheme', () => {
    expect(safeUrl('​javascript:alert(1)')).toBe('#')
    expect(safeUrl('﻿javascript:alert(1)')).toBe('#')
  })

  test('neutralises data: and vbscript: schemes', () => {
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBe('#')
    expect(safeUrl('vbscript:msgbox(1)')).toBe('#')
  })

  test('a javascript: URL escaped into an href does not survive as an active scheme', () => {
    const out = render(html`<a href="${safeUrl('javascript:alert(1)')}">go</a>`)
    expect(out).toBe('<a href="#">go</a>')
  })

  test('an entity-encoded javascript URL stays inert (& is escaped, not decoded)', () => {
    // browsers decode entities in attribute values; escaping & prevents that
    const out = render(html`<a href="${safeUrl('&#106;avascript:alert(1)')}">go</a>`)
    expect(out).not.toContain('&#106;avascript')
    expect(out).toContain('&amp;#106;avascript')
  })
})

describe('join', () => {
  test('joins html fragments with a raw separator', () => {
    const parts = ['x', 'y'].map((v) => html`<i>${v}</i>`)
    expect(render(join(parts, html`, `))).toBe('<i>x</i>, <i>y</i>')
  })

  test('rejects a bare string in the list', () => {
    expect(() => join(['<script>' as unknown as Html])).toThrow(TypeError)
  })
})

describe('fuzz — no hostile payload produces executable HTML at any interpolation point', () => {
  const TEXT_PREFIX = '<span>'
  const TEXT_SUFFIX = '</span>'

  test.each(HOSTILE_PAYLOADS)('text interpolation stays inert: %j', (payload) => {
    const out = render(html`<span>${payload}</span>`)
    expect(out.startsWith(TEXT_PREFIX)).toBe(true)
    expect(out.endsWith(TEXT_SUFFIX)).toBe(true)
    const interior = out.slice(TEXT_PREFIX.length, out.length - TEXT_SUFFIX.length)
    // the payload's own angle brackets and quotes must all be escaped away
    expect(interior).not.toContain('<')
    expect(interior).not.toContain('>')
    expect(interior).not.toContain('"')
    expect(interior).not.toContain("'")
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<svg')
  })

  test.each(HOSTILE_PAYLOADS)('quoted-attribute interpolation stays inert: %j', (payload) => {
    const out = render(html`<div data-x="${payload}"></div>`)
    // only the two attribute delimiter quotes survive
    expect(out.match(/"/g)?.length).toBe(2)
    // no angle bracket from the payload leaks into markup
    const interior = out.slice('<div data-x="'.length, out.indexOf('">'))
    expect(interior).not.toContain('<')
    expect(interior).not.toContain('>')
  })

  test.each(HOSTILE_PAYLOADS)('href interpolation via safeUrl never yields an active scheme: %j', (payload) => {
    const out = render(html`<a href="${safeUrl(payload)}">x</a>`)
    expect(out).not.toContain('<script')
    expect(out.match(/"/g)?.length).toBe(2)
    // no unescaped javascript:/data:/vbscript: scheme reaches the attribute
    expect(/href="\s*javascript:/i.test(out)).toBe(false)
    expect(/href="\s*data:/i.test(out)).toBe(false)
    expect(/href="\s*vbscript:/i.test(out)).toBe(false)
  })
})

describe('tool card rendering — the real attack surface', () => {
  test('hostile tool name, description and argument all render as text', () => {
    const toolName = '<script>steal()</script>'
    const description = '"><iframe src=javascript:alert(1)>'
    const argument = "'; DROP TABLE--<img onerror=alert(1)>"
    const card = html`
      <article>
        <h3>${toolName}</h3>
        <p>${description}</p>
        <code>${argument}</code>
      </article>
    `
    const out = render(card)
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;script&gt;steal()&lt;/script&gt;')
  })
})

describe('assets — inlined strings with precomputed sha256', () => {
  test('css asset carries the right content type', () => {
    expect(APP_CSS.contentType).toBe('text/css; charset=utf-8')
  })

  test('js asset carries a script content type', () => {
    expect(APP_JS.contentType).toBe('text/javascript; charset=utf-8')
  })

  test('etag is the quoted sha256 hex of the body', () => {
    const expected = `"${createHash('sha256').update(APP_CSS.body, 'utf8').digest('hex')}"`
    expect(APP_CSS.etag).toBe(expected)
  })

  test('sha256Base64 matches the body (usable as a CSP hash source)', () => {
    const expected = createHash('sha256').update(APP_JS.body, 'utf8').digest('base64')
    expect(APP_JS.sha256Base64).toBe(expected)
  })

  test('assets set a revalidating Cache-Control', () => {
    expect(APP_CSS.cacheControl).toBe('no-cache')
    expect(APP_JS.cacheControl).toBe('no-cache')
  })

  test('css and js have distinct etags', () => {
    expect(APP_CSS.etag).not.toBe(APP_JS.etag)
  })

  test('app-js references no external origin (CSP forbids CDN/fonts)', () => {
    expect(APP_JS.body).not.toMatch(/https?:\/\//)
  })

  test('app-css references no external origin (no @import/url to a CDN)', () => {
    expect(APP_CSS.body).not.toMatch(/https?:\/\//)
    expect(APP_CSS.body).not.toContain('@import')
  })

  test('app-js exposes the SSE and action DOM-hook contract for Wave 3', () => {
    // data-attributes the page renderers of Wave 3 must emit
    expect(APP_JS.body).toContain('data-action')
    expect(APP_JS.body).toContain('EventSource')
  })
})

describe('layout — CSP-safe page shell', () => {
  const baseOptions = {
    title: 'Approvals',
    content: html`<p>hello</p>`,
    csrfToken: 'csrf-token-value',
  }

  test('emits a complete, well-formed document', () => {
    const out = renderLayout(baseOptions)
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(out).toContain('<html lang="en">')
    expect(out).toContain('<main')
    expect(out).toContain('<p>hello</p>')
  })

  test('references stylesheet and script by same-origin path only (no inline)', () => {
    const out = renderLayout(baseOptions)
    expect(out).toContain('<link rel="stylesheet" href="/assets/app.css">')
    expect(out).toContain('src="/assets/app.js"')
    // no inline <script>…code…</script> and no inline style attribute/tag
    expect(out).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[^<]/)
    expect(out).not.toContain('<style')
  })

  test('carries the CSRF token in a meta tag for app-js to read', () => {
    const out = renderLayout(baseOptions)
    expect(out).toContain('<meta name="csrf-token" content="csrf-token-value">')
  })

  test('escapes a hostile page title', () => {
    const out = renderLayout({ ...baseOptions, title: '<script>alert(1)</script>' })
    expect(out).not.toContain('<script>alert(1)</script>')
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('escapes a hostile CSRF token before it reaches the meta tag', () => {
    const out = renderLayout({ ...baseOptions, csrfToken: '"><script>alert(1)</script>' })
    expect(out).not.toContain('<script>alert(1)</script>')
    expect(out.match(/<meta name="csrf-token" content="[^"]*">/)).not.toBeNull()
  })

  test('escapes an untrusted admin name in the nav', () => {
    const out = renderLayout({
      ...baseOptions,
      currentAdmin: { name: '<img src=x onerror=alert(1)>', role: 'operator' },
    })
    expect(out).not.toContain('<img src=x')
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  test('content is embedded verbatim as pre-built html (not re-escaped)', () => {
    const out = renderLayout({ ...baseOptions, content: html`<em>fine</em>` })
    expect(out).toContain('<em>fine</em>')
  })
})

describe('Html is not constructible from outside this module (LOW-1)', () => {
  test('new Html(untrusted) throws instead of minting unescaped markup', () => {
    // TypeScript refuses this outright (private constructor); the cast proves
    // the guarantee also survives type erasure — a JS caller cannot bypass it.
    const Constructible = Html as unknown as new (value: string) => Html
    expect(() => new Constructible('<script>alert(1)</script>')).toThrow(TypeError)
  })

  test('the two-argument form with a forged key is refused too', () => {
    const Constructible = Html as unknown as new (key: symbol, value: string) => Html
    expect(() => new Constructible(Symbol('Html.construct'), '<script>x</script>')).toThrow(
      TypeError,
    )
  })

  test('fragments built by the tag still render and compose normally', () => {
    const fragment = html`<p>${'<b>x</b>'}</p>`
    expect(render(fragment)).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>')
    expect(render(join([fragment, fragment]))).toBe(
      '<p>&lt;b&gt;x&lt;/b&gt;</p><p>&lt;b&gt;x&lt;/b&gt;</p>',
    )
  })
})
