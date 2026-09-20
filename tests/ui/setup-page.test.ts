import { describe, expect, test } from 'vitest'
import { ADMIN_NAME_PATTERN } from '../../src/admin/constants.js'
import { renderSetupDonePage, renderSetupPage } from '../../src/ui/pages/setup.js'

/**
 * The first-run pages: the "create the owner" form and the one-time token
 * reveal. Both are public documents — no session exists yet — so neither may
 * carry a host path, a script, or anything the visitor did not type.
 */

describe('renderSetupPage', () => {
  test('is a POST /setup form asking for the setup code and the admin name', () => {
    const doc = renderSetupPage()

    expect(doc.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(doc).toContain('<form method="post" action="/setup">')
    expect(doc).toMatch(/<input[^>]*name="code"[^>]*type="password"|<input[^>]*type="password"[^>]*name="code"/s)
    expect(doc).toContain('name="name"')
    expect(doc).toContain('autocomplete="off"')
  })

  test('says the role is owner and where the code is, without naming a host path', () => {
    const doc = renderSetupPage()

    expect(doc).toContain('owner')
    expect(doc).toContain('setup-code')
    expect(doc).not.toMatch(/\/(home|Users|srv|var)\//)
  })

  test('echoes the typed name back, escaped, and never echoes the code', () => {
    const doc = renderSetupPage({ error: 'nope', name: '"><script>x</script>' })

    expect(doc).toContain('&quot;&gt;&lt;script&gt;x&lt;/script&gt;')
    expect(doc).not.toContain('<script>x</script>')
    expect(doc).toMatch(/name="code"/)
    expect(doc).not.toMatch(/name="code"[^>]*value=/)
  })

  test('escapes the error banner and marks it as an alert', () => {
    const doc = renderSetupPage({ error: '<b>bad</b>' })

    expect(doc).toContain('role="alert"')
    expect(doc).toContain('&lt;b&gt;bad&lt;/b&gt;')
  })

  test('the name pattern compiles the way a browser compiles it (the `v` flag) and agrees with the store', () => {
    // Found by the browser smoke: an unescaped `-` inside a class is a
    // SyntaxError under `v`, and a browser then drops the check silently.
    const source = /name="name"[^>]*pattern="([^"]+)"/s.exec(renderSetupPage())?.[1] ?? ''
    const compiled = new RegExp(`^(?:${source.replaceAll('&#92;', '\\')})$`, 'v')

    for (const name of ['alice', 'a', '0-x', 'a'.repeat(64)]) {
      expect([name, compiled.test(name)]).toEqual([name, ADMIN_NAME_PATTERN.test(name)])
    }
    for (const name of ['Alice', '-a', 'a b', 'a'.repeat(65), '']) {
      expect([name, compiled.test(name)]).toEqual([name, ADMIN_NAME_PATTERN.test(name)])
    }
  })

  test('loads no page script', () => {
    expect(renderSetupPage()).not.toContain('login.js')
  })
})

describe('renderSetupDonePage', () => {
  const doc = renderSetupDonePage({ admin: 'alice', token: 'mcpa_secret-token' })

  test('shows the token once, with the shown-once warning and the admin name', () => {
    expect(doc).toContain('alice')
    expect(doc).toContain('<pre class="token" data-token>mcpa_secret-token</pre>')
    expect(doc).toMatch(/shown once/i)
  })

  test('offers a one-press sign-in: a POST /login form carrying the token in a hidden field', () => {
    expect(doc).toContain('<form method="post" action="/login">')
    expect(doc).toContain('<input type="hidden" name="token" value="mcpa_secret-token" />')
  })

  test('escapes both values', () => {
    const hostile = renderSetupDonePage({ admin: '<i>a</i>', token: '"><script>t</script>' })

    expect(hostile).not.toContain('<i>a</i>')
    expect(hostile).not.toContain('<script>t</script>')
  })
})
