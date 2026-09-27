import { describe, expect, test } from 'vitest'
import { renderHubLayout } from '../../hub/src/pages/layout.js'
import { renderNoticePage } from '../../hub/src/pages/notice.js'
import { renderPreparingPage } from '../../hub/src/pages/preparing.js'
import { renderSignedInPage } from '../../hub/src/pages/signed-in.js'
import { html } from '../../src/ui/html.js'
import { expectNoBannedWords } from '../support/banned-words.js'

/**
 * The two pages Task 5 added: the generic notice (404, an action the
 * orchestrator could not complete) and the sign-in hand-over to `/account`.
 */

describe('renderNoticePage', () => {
  test('escapes the title and the message', () => {
    const page = renderNoticePage({ status: 'Not found', message: '<b>x</b>' })

    expect(page).toContain('<h1>Not found</h1>')
    expect(page).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(page).not.toContain('<b>x</b>')
  })

  test('signed in, it carries the nav and the CSRF token', () => {
    const page = renderNoticePage({ status: 'Owner token not issued', message: 'm', signedIn: true, csrfToken: 'tok' })

    expect(page).toContain('Sign out')
    expect(page).toContain('<meta name="csrf-token" content="tok">')
    expect(page).toContain('href="/account"')
  })

  test('signed out, it links home and has no sign-out', () => {
    const page = renderNoticePage({ status: 'Not found', message: 'm' })

    expect(page).not.toContain('Sign out')
    expect(page).toContain('href="/"')
    expectNoBannedWords(page)
  })
})

describe('renderSignedInPage', () => {
  test('moves on to /account at once, with a link for anyone whose browser does not', () => {
    const page = renderSignedInPage({ login: 'alice', csrfToken: 'tok' })

    expect(page).toContain('<meta http-equiv="refresh" content="0; url=/account">')
    expect(page).toContain('href="/account"')
    expect(page).toContain('@alice')
    expect(page).not.toMatch(/<script/i)
  })
})

describe('renderPreparingPage', () => {
  test('asks /account again every 3 seconds, signed in, with a link and no script', () => {
    const page = renderPreparingPage({ login: '<b>alice</b>', csrfToken: 'tok' })

    expect(page).toContain('<meta http-equiv="refresh" content="3; url=/account">')
    expect(page).toContain('Preparing your install')
    expect(page).toContain('href="/account"')
    expect(page).toContain('Sign out')
    expect(page).toContain('&lt;b&gt;alice&lt;/b&gt;')
    expect(page).not.toMatch(/<script/i)
    expectNoBannedWords(page)
  })
})

describe('renderHubLayout — refresh delay', () => {
  test('refuses a delay that is not a whole number of seconds', () => {
    const render = (seconds: number): string =>
      renderHubLayout({ title: 't', content: html``, csrfToken: '', refreshTo: '/account', refreshAfterSeconds: seconds })

    expect(render(0)).toContain('content="0; url=/account"')
    expect(() => render(-1)).toThrow(RangeError)
    expect(() => render(1.5)).toThrow(RangeError)
  })
})
